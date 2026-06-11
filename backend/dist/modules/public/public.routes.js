"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicRouter = void 0;
const express_1 = require("express");
const prisma_js_1 = require("../../config/prisma.js");
const crypto_js_1 = require("../../utils/crypto.js");
const stream_google_file_js_1 = require("../files/stream-google-file.js");
exports.publicRouter = (0, express_1.Router)();
async function findSharedFile(token) {
    const share = await prisma_js_1.prisma.fileShare.findFirst({
        where: { enabled: true, AND: [{ OR: [{ token }, { tokenHash: (0, crypto_js_1.hashToken)(token) }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }] },
        include: { file: { include: { connectedAccount: true } } },
    });
    if (!share || share.file.status !== 'active')
        throw new Error('Shared file not found');
    return share.file;
}
exports.publicRouter.get('/files/:token', async (req, res, next) => {
    try {
        const file = await findSharedFile(String(req.params.token));
        return res.json({ file: { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), createdAt: file.createdAt } });
    }
    catch (error) {
        return next(error);
    }
});
exports.publicRouter.get('/files/:token/download', async (req, res, next) => {
    try {
        const file = await findSharedFile(String(req.params.token));
        return (0, stream_google_file_js_1.streamGoogleFile)(file, req.headers.range, res, { disposition: 'attachment' });
    }
    catch (error) {
        return next(error);
    }
});
exports.publicRouter.get('/files/:token/preview', async (req, res, next) => {
    try {
        const file = await findSharedFile(String(req.params.token));
        return (0, stream_google_file_js_1.streamGoogleFile)(file, req.headers.range, res, { disposition: 'inline' });
    }
    catch (error) {
        return next(error);
    }
});
