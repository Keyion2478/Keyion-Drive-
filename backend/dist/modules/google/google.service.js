"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOAuthClient = createOAuthClient;
exports.getAuthedGoogleClient = getAuthedGoogleClient;
exports.syncGoogleQuota = syncGoogleQuota;
exports.ensureGoogleAppFolder = ensureGoogleAppFolder;
exports.syncGoogleAppFolderFiles = syncGoogleAppFolderFiles;
const googleapis_1 = require("googleapis");
const prisma_js_1 = require("../../config/prisma.js");
const crypto_js_1 = require("../../utils/crypto.js");
const googleDriveFolderMimeType = 'application/vnd.google-apps.folder';
const appFolderName = '9drive';
function createOAuthClient(config) {
    return new googleapis_1.google.auth.OAuth2((0, crypto_js_1.decryptText)(config.clientIdEncrypted), (0, crypto_js_1.decryptText)(config.clientSecretEncrypted), config.redirectUri);
}
async function getAuthedGoogleClient(account) {
    const config = await prisma_js_1.prisma.providerConfig.findUniqueOrThrow({ where: { id: account.providerConfigId } });
    const client = createOAuthClient(config);
    client.setCredentials({
        access_token: (0, crypto_js_1.decryptText)(account.accessTokenEncrypted),
        refresh_token: (0, crypto_js_1.decryptText)(account.refreshTokenEncrypted),
        expiry_date: account.tokenExpiresAt.getTime(),
    });
    if (account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
        const result = await client.refreshAccessToken();
        const credentials = result.credentials;
        if (credentials.access_token) {
            await prisma_js_1.prisma.connectedAccount.update({
                where: { id: account.id },
                data: {
                    accessTokenEncrypted: (0, crypto_js_1.encryptText)(credentials.access_token),
                    tokenExpiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
                },
            });
            client.setCredentials(credentials);
        }
    }
    return client;
}
async function syncGoogleQuota(accountId) {
    const account = await prisma_js_1.prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    const auth = await getAuthedGoogleClient(account);
    const drive = googleapis_1.google.drive({ version: 'v3', auth });
    const about = await drive.about.get({ fields: 'storageQuota,user' });
    const quota = about.data.storageQuota;
    const total = quota?.limit ? BigInt(quota.limit) : null;
    const used = quota?.usage ? BigInt(quota.usage) : 0n;
    return prisma_js_1.prisma.storageAccount.upsert({
        where: { connectedAccountId: accountId },
        create: {
            connectedAccountId: accountId,
            totalBytes: total,
            usedBytes: used,
            availableBytes: total === null ? null : total - used,
            trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
            lastSyncedAt: new Date(),
        },
        update: {
            totalBytes: total,
            usedBytes: used,
            availableBytes: total === null ? null : total - used,
            trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
            lastSyncedAt: new Date(),
        },
    });
}
function escapeDriveQueryValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
async function ensureGoogleAppFolder(account) {
    const auth = await getAuthedGoogleClient(account);
    const drive = googleapis_1.google.drive({ version: 'v3', auth });
    const queryName = escapeDriveQueryValue(appFolderName);
    const existing = await drive.files.list({
        q: `name = '${queryName}' and mimeType = '${googleDriveFolderMimeType}' and 'root' in parents and trashed = false`,
        spaces: 'drive',
        fields: 'files(id,name)',
        pageSize: 1,
    });
    const folderId = existing.data.files?.[0]?.id ?? (await drive.files.create({
        requestBody: { name: appFolderName, mimeType: googleDriveFolderMimeType, parents: ['root'] },
        fields: 'id',
    })).data.id;
    if (!folderId)
        throw new Error('Failed to create Google Drive app folder.');
    return folderId;
}
async function syncGoogleAppFolderFiles(accountId, userId) {
    const account = await prisma_js_1.prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'google_drive', status: 'connected' } });
    const auth = await getAuthedGoogleClient(account);
    const drive = googleapis_1.google.drive({ version: 'v3', auth });
    const appFolderId = await ensureGoogleAppFolder(account);
    const driveFiles = [];
    let pageToken;
    do {
        const response = await drive.files.list({
            q: `'${appFolderId}' in parents and mimeType != '${googleDriveFolderMimeType}' and trashed = false`,
            spaces: 'drive',
            fields: 'nextPageToken,files(id,name,mimeType,size)',
            pageSize: 1000,
            pageToken,
        });
        for (const file of response.data.files ?? []) {
            if (!file.id || !file.name || !file.mimeType)
                continue;
            driveFiles.push({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: BigInt(file.size ?? 0) });
        }
        pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    const existingFiles = await prisma_js_1.prisma.file.findMany({ where: { userId, connectedAccountId: account.id, provider: 'google_drive' } });
    const existingByProviderId = new Map(existingFiles.map((file) => [file.providerFileId, file]));
    const driveFileIds = new Set(driveFiles.map((file) => file.id));
    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const driveFile of driveFiles) {
        const existing = existingByProviderId.get(driveFile.id);
        if (!existing) {
            await prisma_js_1.prisma.file.create({
                data: { userId, connectedAccountId: account.id, provider: 'google_drive', providerFileId: driveFile.id, name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active' },
            });
            created += 1;
            continue;
        }
        const needsUpdate = existing.name !== driveFile.name || existing.mimeType !== driveFile.mimeType || existing.sizeBytes !== driveFile.sizeBytes || existing.status !== 'active' || existing.deletedAt !== null;
        if (needsUpdate) {
            await prisma_js_1.prisma.file.update({
                where: { id: existing.id },
                data: { name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active', deletedAt: null },
            });
            updated += 1;
        }
    }
    const missingActiveIds = existingFiles.filter((file) => file.status === 'active' && !driveFileIds.has(file.providerFileId)).map((file) => file.id);
    if (missingActiveIds.length > 0) {
        const result = await prisma_js_1.prisma.file.updateMany({ where: { id: { in: missingActiveIds }, userId }, data: { status: 'deleted', deletedAt: new Date() } });
        deleted = result.count;
    }
    await syncGoogleQuota(account.id).catch(() => undefined);
    return { accountId: account.id, created, updated, deleted };
}
