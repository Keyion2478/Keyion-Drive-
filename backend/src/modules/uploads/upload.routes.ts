import Busboy from 'busboy'
import { Router } from 'express'
import { google } from 'googleapis'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'

export const uploadRouter = Router()
uploadRouter.use(requireAuth)

type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string }

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

function syncQuotaInBackground(accountId: string, sessionId: string) {
  logUpload('quota sync started', { accountId, sessionId })
  syncGoogleQuota(accountId)
    .then(() => logUpload('quota sync completed', { accountId, sessionId }))
    .catch((error) => logUpload('quota sync failed', { accountId, sessionId, message: error instanceof Error ? error.message : 'Unknown error' }))
}

async function selectAccount(userId: string, sizeBytes: bigint, reservedBytesByAccount = new Map<string, bigint>()) {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: 'google_drive', status: 'connected' },
    include: { storageAccount: true },
  })

  const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  for (const account of stale) await syncGoogleQuota(account.id)

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, provider: 'google_drive', status: 'connected' },
    include: { storageAccount: true },
  })

  return fresh
    .map((account) => ({ account, availableBytes: (account.storageAccount?.availableBytes ?? 0n) - (reservedBytesByAccount.get(account.id) ?? 0n) }))
    .filter(({ availableBytes }) => availableBytes >= sizeBytes)
    .sort((a, b) => Number(b.availableBytes - a.availableBytes))[0]?.account
}

uploadRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    const busboy = Busboy({ headers: req.headers, limits: { files: 10000, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let responded = false
    let fileSeen = false
    const reservedBytesByAccount = new Map<string, bigint>()
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string }> = []
    const pendingUploads: Array<Promise<void>> = []

    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      return res.status(status).json({ code, message })
    }

    const parseBatchMeta = (value: string) => JSON.parse(value).map((item: { fieldName: string; fileName: string; mimeType: string; sizeBytes: string | number; folderId?: string }) => ({
      fieldName: item.fieldName,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: BigInt(item.sizeBytes),
      folderId: item.folderId,
    })) as UploadMeta[]

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }) => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId }
    }

    const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const meta = metaForFile(fieldName, info)
      const fileName = meta?.fileName || info.filename
      try {
        fileStream.on('limit', () => logUpload('file stream size limit reached', { fileName }))
        if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
          return
        }
        if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }

        const account = await selectAccount(req.user!.id, meta.sizeBytes, reservedBytesByAccount)
        if (!account) {
          fileStream.resume()
          failed.push({ fileName, code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected Google Drive account has enough space for this upload.' })
          return
        }
        reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes)

        const folderId = meta.folderId || null
        if (folderId) await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })

        const session = await prisma.uploadSession.create({ data: { userId: req.user!.id, targetConnectedAccountId: account.id, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
        logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })
        const auth = await getAuthedGoogleClient(account)
        const drive = google.drive({ version: 'v3', auth })
        const appFolderId = await ensureGoogleAppFolder(account)

        let streamedBytes = 0n
        fileStream.on('data', (chunk: Buffer) => {
          streamedBytes += BigInt(chunk.length)
        })

        const uploaded = await drive.files.create({
          requestBody: { name: fileName, parents: [appFolderId] },
          media: { mimeType: meta.mimeType, body: fileStream },
          fields: 'id,name,mimeType,size',
        })
        logUpload('google upload completed', { sessionId: session.id, accountId: account.id, fileName })

        if (streamedBytes !== meta.sizeBytes) {
          await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
          failed.push({ fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' })
          return
        }

        const file = await prisma.file.create({
          data: {
            userId: req.user!.id,
            connectedAccountId: account.id,
            folderId,
            provider: 'google_drive',
            providerFileId: uploaded.data.id ?? '',
            name: uploaded.data.name ?? fileName,
            mimeType: uploaded.data.mimeType ?? meta.mimeType,
            sizeBytes: meta.sizeBytes,
          },
        })
        logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id })
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
        completed.push({ ...file, sizeBytes: file.sizeBytes.toString() })
        syncQuotaInBackground(account.id, session.id)
      } catch (error) {
        fileStream.resume()
        logUpload('file upload failed', { fileName, message: error instanceof Error ? error.message : 'Upload failed' })
        failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
      }
    }

    busboy.on('field', (name, value) => {
      if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
      if (name === 'fileName') fields.fileName = value
      if (name === 'mimeType') fields.mimeType = value
      if (name === 'folderId') fields.folderId = value
      if (name === 'filesMeta') batchMeta = parseBatchMeta(value)
    })

    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      pendingUploads.push(uploadOne(name, fileStream, info))
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      Promise.all(pendingUploads).then(() => {
        if (responded) return
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed })
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
})
