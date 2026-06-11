"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerConfigRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_js_1 = require("../../config/prisma.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
const crypto_js_1 = require("../../utils/crypto.js");
exports.providerConfigRouter = (0, express_1.Router)();
exports.providerConfigRouter.use(auth_middleware_js_1.requireAuth);
const schema = zod_1.z.object({
    clientId: zod_1.z.string().min(1),
    clientSecret: zod_1.z.string().min(1),
    redirectUri: zod_1.z.string().url(),
    scopes: zod_1.z.array(zod_1.z.string()).min(1),
});
exports.providerConfigRouter.post('/google', async (req, res, next) => {
    try {
        const body = schema.parse(req.body);
        const config = await prisma_js_1.prisma.providerConfig.create({
            data: {
                userId: req.user.id,
                provider: 'google_drive',
                clientIdEncrypted: (0, crypto_js_1.encryptText)(body.clientId),
                clientSecretEncrypted: (0, crypto_js_1.encryptText)(body.clientSecret),
                redirectUri: body.redirectUri,
                scopes: body.scopes,
            },
        });
        return res.status(201).json({ id: config.id, provider: config.provider, redirectUri: config.redirectUri, scopes: config.scopes, status: config.status });
    }
    catch (error) {
        return next(error);
    }
});
exports.providerConfigRouter.get('/', async (req, res, next) => {
    try {
        const configs = await prisma_js_1.prisma.providerConfig.findMany({ where: { userId: req.user.id }, select: { id: true, provider: true, redirectUri: true, scopes: true, status: true, createdAt: true } });
        return res.json({ configs });
    }
    catch (error) {
        return next(error);
    }
});
exports.providerConfigRouter.delete('/:id', async (req, res, next) => {
    try {
        await prisma_js_1.prisma.providerConfig.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } });
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
