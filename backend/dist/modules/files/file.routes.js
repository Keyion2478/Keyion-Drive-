"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileRouter = void 0;
const express_1 = require("express");
const googleapis_1 = require("googleapis");
const zod_1 = require("zod");
const prisma_js_1 = require("../../config/prisma.js");
const env_js_1 = require("../../config/env.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
const crypto_js_1 = require("../../utils/crypto.js");
const google_service_js_1 = require("../google/google.service.js");
const stream_google_file_js_1 = require("./stream-google-file.js");
exports.fileRouter = (0, express_1.Router)();
exports.fileRouter.get('/preview/:token', async (req, res, next) => {
    try {
        const token = String(req.params.token);
        const preview = await prisma_js_1.prisma.filePreviewToken.findFirst({
            where: { tokenHash: (0, crypto_js_1.hashToken)(token), expiresAt: { gt: new Date() } },
            include: { file: { include: { connectedAccount: true } } },
        });
        if (!preview || preview.file.status !== 'active')
            return res.status(404).json({ code: 'PREVIEW_NOT_FOUND', message: 'Preview token not found.' });
        return (0, stream_google_file_js_1.streamGoogleFile)(preview.file, req.headers.range, res, { disposition: 'inline' });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.use(auth_middleware_js_1.requireAuth);
exports.fileRouter.get('/', async (req, res, next) => {
    try {
        const query = zod_1.z.object({ folderId: zod_1.z.string().optional(), q: zod_1.z.string().trim().max(255).optional() }).parse(req.query);
        const files = await prisma_js_1.prisma.file.findMany({ where: { userId: req.user.id, status: 'active', ...(query.folderId ? { folderId: query.folderId } : {}), ...(query.q ? { name: { contains: query.q } } : {}) }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } });
        return res.json({ files: files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() })) });
    }
    catch (error) {
        return next(error);
    }
});
const batchFileSchema = zod_1.z.object({ fileIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(1000) });
exports.fileRouter.patch('/batch', async (req, res, next) => {
    try {
        const body = batchFileSchema.extend({ folderId: zod_1.z.string().nullable().optional() }).parse(req.body);
        if (body.folderId)
            await prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user.id, deletedAt: null } });
        const result = await prisma_js_1.prisma.file.updateMany({ where: { id: { in: body.fileIds }, userId: req.user.id, status: 'active' }, data: { folderId: body.folderId ?? null } });
        return res.json({ status: 'ok', moved: result.count });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.delete('/batch', async (req, res, next) => {
    try {
        const body = batchFileSchema.parse(req.body);
        const files = await prisma_js_1.prisma.file.findMany({ where: { id: { in: body.fileIds }, userId: req.user.id, status: 'active' }, include: { connectedAccount: true } });
        const deletedIds = [];
        const syncedAccountIds = new Set();
        const failed = [];
        const BATCH_SIZE = 10;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (file) => {
                try {
                    const auth = await (0, google_service_js_1.getAuthedGoogleClient)(file.connectedAccount);
                    const drive = googleapis_1.google.drive({
                        version: 'v3',
                        auth
                    });
                    await drive.files.delete({
                        fileId: file.providerFileId
                    });
                    deletedIds.push(file.id);
                    syncedAccountIds.add(file.connectedAccountId);
                }
                catch (error) {
                    failed.push({
                        fileId: file.id,
                        message: error instanceof Error
                            ? error.message
                            : 'Delete failed'
                    });
                }
            }));
        }
        if (deletedIds.length > 0)
            await prisma_js_1.prisma.file.updateMany({ where: { id: { in: deletedIds }, userId: req.user.id }, data: { status: 'deleted', deletedAt: new Date() } });
        for (const accountId of syncedAccountIds)
            await (0, google_service_js_1.syncGoogleQuota)(accountId).catch(() => undefined);
        if (deletedIds.length === 0 && failed.length > 0)
            return res.status(400).json({ code: 'FILES_DELETE_FAILED', message: 'No files were deleted.', deleted: 0, failed });
        return res.json({ status: 'ok', deleted: deletedIds.length, failed });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.get('/shared-links', async (req, res, next) => {
    try {
        const shares = await prisma_js_1.prisma.fileShare.findMany({
            where: { userId: req.user.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            include: { file: { include: { connectedAccount: { select: { email: true, provider: true } }, folder: { select: { id: true, name: true } } } } },
            orderBy: { createdAt: 'desc' },
        });
        return res.json({
            shares: shares.filter((share) => share.file.status === 'active').map((share) => ({
                id: share.id,
                url: share.token ? `${env_js_1.env.FRONTEND_URL}/public/files/${share.token}` : null,
                createdAt: share.createdAt.toISOString(),
                expiresAt: share.expiresAt?.toISOString() ?? null,
                file: { ...share.file, sizeBytes: share.file.sizeBytes.toString() },
            })),
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.post('/sync-google', async (req, res, next) => {
    try {
        const body = zod_1.z.object({ connectedAccountId: zod_1.z.string().min(1).optional() }).parse(req.body ?? {});
        const accounts = await prisma_js_1.prisma.connectedAccount.findMany({
            where: { userId: req.user.id, provider: 'google_drive', status: 'connected', ...(body.connectedAccountId ? { id: body.connectedAccountId } : {}) },
            select: { id: true },
        });
        const results = [];
        for (const account of accounts)
            results.push(await (0, google_service_js_1.syncGoogleAppFolderFiles)(account.id, req.user.id));
        return res.json({
            status: 'ok',
            accounts: results.length,
            created: results.reduce((total, result) => total + result.created, 0),
            updated: results.reduce((total, result) => total + result.updated, 0),
            deleted: results.reduce((total, result) => total + result.deleted, 0),
            results,
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.get('/:id', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } });
        return res.json({ file: { ...file, sizeBytes: file.sizeBytes.toString() } });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.patch('/:id', async (req, res, next) => {
    try {
        const body = zod_1.z.object({ name: zod_1.z.string().min(1).max(255).optional(), folderId: zod_1.z.string().nullable().optional() }).parse(req.body);
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id }, include: { connectedAccount: true } });
        const auth = await (0, google_service_js_1.getAuthedGoogleClient)(file.connectedAccount);
        const drive = googleapis_1.google.drive({ version: 'v3', auth });
        if (body.folderId)
            await prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user.id, deletedAt: null } });
        if (body.name)
            await drive.files.update({ fileId: file.providerFileId, requestBody: { name: body.name } });
        const updated = await prisma_js_1.prisma.file.update({ where: { id: file.id }, data: { ...(body.name ? { name: body.name } : {}), ...(body.folderId !== undefined ? { folderId: body.folderId } : {}) }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } });
        return res.json({ file: { ...updated, sizeBytes: updated.sizeBytes.toString() } });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.post('/:id/share', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id, status: 'active' } });
        const existingShare = await prisma_js_1.prisma.fileShare.findFirst({ where: { fileId: file.id, userId: req.user.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } });
        if (existingShare?.token)
            return res.json({ url: `${env_js_1.env.FRONTEND_URL}/public/files/${existingShare.token}`, shareId: existingShare.id });
        if (existingShare)
            await prisma_js_1.prisma.fileShare.update({ where: { id: existingShare.id }, data: { enabled: false } });
        const token = (0, crypto_js_1.randomToken)(32);
        const share = await prisma_js_1.prisma.fileShare.create({ data: { fileId: file.id, userId: req.user.id, token, tokenHash: (0, crypto_js_1.hashToken)(token) } });
        return res.status(201).json({ url: `${env_js_1.env.FRONTEND_URL}/public/files/${token}`, shareId: share.id });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.delete('/:id/share', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        await prisma_js_1.prisma.fileShare.updateMany({ where: { fileId, userId: req.user.id, enabled: true }, data: { enabled: false } });
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.post('/:id/preview-token', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id, status: 'active' } });
        const token = (0, crypto_js_1.randomToken)(32);
        await prisma_js_1.prisma.filePreviewToken.create({ data: { fileId: file.id, userId: req.user.id, tokenHash: (0, crypto_js_1.hashToken)(token), expiresAt: new Date(Date.now() + 10 * 60_000) } });
        const path = `/files/preview/${token}`;
        return res.status(201).json({ path, url: `${req.protocol}://${req.get('host')}${path}` });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.get('/:id/view-url', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id }, include: { connectedAccount: true } });
        const auth = await (0, google_service_js_1.getAuthedGoogleClient)(file.connectedAccount);
        const drive = googleapis_1.google.drive({ version: 'v3', auth });
        const metadata = await drive.files.get({ fileId: file.providerFileId, fields: 'webViewLink,webContentLink' });
        return res.json({ url: metadata.data.webViewLink ?? metadata.data.webContentLink });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.get('/:id/download', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id }, include: { connectedAccount: true } });
        return (0, stream_google_file_js_1.streamGoogleFile)(file, req.headers.range, res, { disposition: 'attachment' });
    }
    catch (error) {
        return next(error);
    }
});
exports.fileRouter.delete('/:id', async (req, res, next) => {
    try {
        const fileId = String(req.params.id);
        const file = await prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user.id }, include: { connectedAccount: true } });
        const auth = await (0, google_service_js_1.getAuthedGoogleClient)(file.connectedAccount);
        const drive = googleapis_1.google.drive({ version: 'v3', auth });
        await drive.files.delete({ fileId: file.providerFileId });
        await prisma_js_1.prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } });
        await (0, google_service_js_1.syncGoogleQuota)(file.connectedAccountId);
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
