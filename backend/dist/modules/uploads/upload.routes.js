"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadRouter = void 0;
const busboy_1 = __importDefault(require("busboy"));
const express_1 = require("express");
const googleapis_1 = require("googleapis");
const env_js_1 = require("../../config/env.js");
const prisma_js_1 = require("../../config/prisma.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
const google_service_js_1 = require("../google/google.service.js");
exports.uploadRouter = (0, express_1.Router)();
exports.uploadRouter.use(auth_middleware_js_1.requireAuth);
function logUpload(message, metadata) {
    console.info('[upload]', message, metadata ?? '');
}
function syncQuotaInBackground(accountId, sessionId) {
    logUpload('quota sync started', { accountId, sessionId });
    (0, google_service_js_1.syncGoogleQuota)(accountId)
        .then(() => logUpload('quota sync completed', { accountId, sessionId }))
        .catch((error) => logUpload('quota sync failed', { accountId, sessionId, message: error instanceof Error ? error.message : 'Unknown error' }));
}
async function selectAccount(userId, sizeBytes, reservedBytesByAccount = new Map()) {
    const accounts = await prisma_js_1.prisma.connectedAccount.findMany({
        where: { userId, provider: 'google_drive', status: 'connected' },
        include: { storageAccount: true },
    });
    const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000);
    for (const account of stale)
        await (0, google_service_js_1.syncGoogleQuota)(account.id);
    const fresh = await prisma_js_1.prisma.connectedAccount.findMany({
        where: { userId, provider: 'google_drive', status: 'connected' },
        include: { storageAccount: true },
    });
    return fresh
        .map((account) => ({ account, availableBytes: (account.storageAccount?.availableBytes ?? 0n) - (reservedBytesByAccount.get(account.id) ?? 0n) }))
        .filter(({ availableBytes }) => availableBytes >= sizeBytes)
        .sort((a, b) => Number(b.availableBytes - a.availableBytes))[0]?.account;
}
exports.uploadRouter.post('/', async (req, res, next) => {
    try {
        logUpload('request started', { userId: req.user.id, contentLength: req.headers['content-length'] });
        const contentType = req.headers['content-type'];
        if (!contentType?.includes('multipart/form-data'))
            return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' });
        const busboy = (0, busboy_1.default)({ headers: req.headers, limits: { files: 10000, fileSize: env_js_1.env.MAX_UPLOAD_BYTES } });
        const fields = {};
        let batchMeta = null;
        let responded = false;
        let fileSeen = false;
        const reservedBytesByAccount = new Map();
        const completed = [];
        const failed = [];
        const pendingUploads = [];
        const fail = async (status, code, message) => {
            if (responded)
                return;
            responded = true;
            req.unpipe(busboy);
            req.resume();
            return res.status(status).json({ code, message });
        };
        const parseBatchMeta = (value) => JSON.parse(value).map((item) => ({
            fieldName: item.fieldName,
            fileName: item.fileName,
            mimeType: item.mimeType,
            sizeBytes: BigInt(item.sizeBytes),
            folderId: item.folderId,
        }));
        const metaForFile = (fieldName, info) => {
            if (batchMeta)
                return batchMeta.find((item) => item.fieldName === fieldName);
            const sizeBytes = fields.sizeBytes;
            if (!sizeBytes)
                return null;
            return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId };
        };
        const uploadOne = async (fieldName, fileStream, info) => {
            const meta = metaForFile(fieldName, info);
            const fileName = meta?.fileName || info.filename;
            try {
                fileStream.on('limit', () => logUpload('file stream size limit reached', { fileName }));
                if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
                    fileStream.resume();
                    failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' });
                    return;
                }
                if (meta.sizeBytes > BigInt(env_js_1.env.MAX_UPLOAD_BYTES)) {
                    fileStream.resume();
                    failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' });
                    return;
                }
                const account = await selectAccount(req.user.id, meta.sizeBytes, reservedBytesByAccount);
                if (!account) {
                    fileStream.resume();
                    failed.push({ fileName, code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected Google Drive account has enough space for this upload.' });
                    return;
                }
                reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes);
                const folderId = meta.folderId || null;
                if (folderId)
                    await prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user.id, deletedAt: null } });
                const session = await prisma_js_1.prisma.uploadSession.create({ data: { userId: req.user.id, targetConnectedAccountId: account.id, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } });
                logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() });
                const auth = await (0, google_service_js_1.getAuthedGoogleClient)(account);
                const drive = googleapis_1.google.drive({ version: 'v3', auth });
                const appFolderId = await (0, google_service_js_1.ensureGoogleAppFolder)(account);
                let streamedBytes = 0n;
                fileStream.on('data', (chunk) => {
                    streamedBytes += BigInt(chunk.length);
                });
                const uploaded = await drive.files.create({
                    requestBody: { name: fileName, parents: [appFolderId] },
                    media: { mimeType: meta.mimeType, body: fileStream },
                    fields: 'id,name,mimeType,size',
                });
                logUpload('google upload completed', { sessionId: session.id, accountId: account.id, fileName });
                if (streamedBytes !== meta.sizeBytes) {
                    await prisma_js_1.prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } });
                    failed.push({ fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' });
                    return;
                }
                const file = await prisma_js_1.prisma.file.create({
                    data: {
                        userId: req.user.id,
                        connectedAccountId: account.id,
                        folderId,
                        provider: 'google_drive',
                        providerFileId: uploaded.data.id ?? '',
                        name: uploaded.data.name ?? fileName,
                        mimeType: uploaded.data.mimeType ?? meta.mimeType,
                        sizeBytes: meta.sizeBytes,
                    },
                });
                logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id });
                await prisma_js_1.prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } });
                completed.push({ ...file, sizeBytes: file.sizeBytes.toString() });
                syncQuotaInBackground(account.id, session.id);
            }
            catch (error) {
                fileStream.resume();
                logUpload('file upload failed', { fileName, message: error instanceof Error ? error.message : 'Upload failed' });
                failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' });
            }
        };
        busboy.on('field', (name, value) => {
            if (name === 'sizeBytes')
                fields.sizeBytes = BigInt(value);
            if (name === 'fileName')
                fields.fileName = value;
            if (name === 'mimeType')
                fields.mimeType = value;
            if (name === 'folderId')
                fields.folderId = value;
            if (name === 'filesMeta')
                batchMeta = parseBatchMeta(value);
        });
        busboy.on('file', (name, fileStream, info) => {
            fileSeen = true;
            pendingUploads.push(uploadOne(name, fileStream, info));
        });
        busboy.on('error', (error) => {
            logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' });
            if (!responded) {
                responded = true;
                next(error);
            }
        });
        busboy.on('finish', () => {
            if (!responded && !fileSeen)
                return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.');
            Promise.all(pendingUploads).then(() => {
                if (responded)
                    return;
                responded = true;
                logUpload('response sent', { completed: completed.length, failed: failed.length });
                if (completed.length === 0)
                    return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed });
                if (!batchMeta && completed.length === 1 && failed.length === 0)
                    return res.status(201).json({ file: completed[0] });
                return res.status(201).json({ files: completed, failed });
            }).catch(next);
        });
        req.pipe(busboy);
    }
    catch (error) {
        return next(error);
    }
});
