"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectedAccountRouter = void 0;
const express_1 = require("express");
const googleapis_1 = require("googleapis");
const zod_1 = require("zod");
const env_js_1 = require("../../config/env.js");
const prisma_js_1 = require("../../config/prisma.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
const crypto_js_1 = require("../../utils/crypto.js");
const password_js_1 = require("../../utils/password.js");
const google_service_js_1 = require("../google/google.service.js");
exports.connectedAccountRouter = (0, express_1.Router)();
exports.connectedAccountRouter.get('/', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        const accounts = await prisma_js_1.prisma.connectedAccount.findMany({
            where: { userId: req.user.id, status: 'connected' },
            include: { storageAccount: true },
            orderBy: { createdAt: 'desc' },
        });
        const missingQuota = accounts.filter((account) => !account.storageAccount?.lastSyncedAt);
        for (const account of missingQuota)
            await (0, google_service_js_1.syncGoogleQuota)(account.id).catch(() => undefined);
        const syncedAccounts = missingQuota.length > 0
            ? await prisma_js_1.prisma.connectedAccount.findMany({
                where: { userId: req.user.id, status: 'connected' },
                include: { storageAccount: true },
                orderBy: { createdAt: 'desc' },
            })
            : accounts;
        return res.json({
            accounts: syncedAccounts.map(({ accessTokenEncrypted: _a, refreshTokenEncrypted: _r, storageAccount, ...account }) => ({
                ...account,
                storageAccount: storageAccount ? {
                    ...storageAccount,
                    totalBytes: storageAccount.totalBytes?.toString() ?? null,
                    usedBytes: storageAccount.usedBytes.toString(),
                    availableBytes: storageAccount.availableBytes?.toString() ?? null,
                    trashBytes: storageAccount.trashBytes?.toString() ?? null,
                } : null,
            })),
        });
    }
    catch (error) {
        return next(error);
    }
});
async function createGoogleConnectUrl(req) {
    const query = zod_1.z.object({ providerConfigId: zod_1.z.string().min(1).optional() }).parse(req.query);
    const config = query.providerConfigId
        ? await prisma_js_1.prisma.providerConfig.findFirstOrThrow({ where: { id: query.providerConfigId, OR: [{ userId: req.user.id }, { userId: null }], provider: 'google_drive', status: 'active' } })
        : await prisma_js_1.prisma.providerConfig.findFirstOrThrow({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } });
    const state = (0, crypto_js_1.randomToken)();
    await prisma_js_1.prisma.oauthState.create({ data: { userId: req.user.id, providerConfigId: config.id, flow: 'connect', stateHash: (0, crypto_js_1.hashToken)(state), expiresAt: new Date(Date.now() + 10 * 60_000) } });
    const client = (0, google_service_js_1.createOAuthClient)(config);
    return client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: true,
        scope: config.scopes,
        state,
    });
}
exports.connectedAccountRouter.get('/google/connect-url', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        const url = await createGoogleConnectUrl(req);
        return res.json({ url });
    }
    catch (error) {
        return next(error);
    }
});
exports.connectedAccountRouter.get('/google/connect', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        const url = await createGoogleConnectUrl(req);
        return res.redirect(url);
    }
    catch (error) {
        return next(error);
    }
});
exports.connectedAccountRouter.get('/google/callback', async (req, res, next) => {
    try {
        const query = zod_1.z.object({ code: zod_1.z.string(), state: zod_1.z.string() }).parse(req.query);
        const oauthState = await prisma_js_1.prisma.oauthState.findUniqueOrThrow({ where: { stateHash: (0, crypto_js_1.hashToken)(query.state) }, include: { providerConfig: true } });
        if (oauthState.usedAt || oauthState.expiresAt < new Date())
            return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' });
        const client = (0, google_service_js_1.createOAuthClient)(oauthState.providerConfig);
        const tokenResult = await client.getToken(query.code);
        const tokens = tokenResult.tokens;
        if (!tokens.access_token)
            return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' });
        client.setCredentials(tokens);
        const oauth2 = googleapis_1.google.oauth2({ version: 'v2', auth: client });
        const profile = await oauth2.userinfo.get();
        const providerAccountId = profile.data.id;
        const email = profile.data.email;
        if (!providerAccountId || !email)
            return res.status(400).json({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' });
        if (oauthState.flow === 'login') {
            const name = profile.data.name || email.split('@')[0] || 'Google User';
            const user = await prisma_js_1.prisma.user.upsert({
                where: { email },
                create: { email, name, passwordHash: await (0, password_js_1.hashPassword)((0, crypto_js_1.randomToken)(32)) },
                update: { name },
            });
            const existingAccount = await prisma_js_1.prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } } });
            const refreshTokenEncrypted = tokens.refresh_token ? (0, crypto_js_1.encryptText)(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted;
            if (!refreshTokenEncrypted)
                return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-auth?status=error`);
            const account = await prisma_js_1.prisma.connectedAccount.upsert({
                where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } },
                create: {
                    userId: user.id,
                    providerConfigId: oauthState.providerConfigId,
                    provider: 'google_drive',
                    providerAccountId,
                    email,
                    displayName: profile.data.name,
                    avatarUrl: profile.data.picture,
                    accessTokenEncrypted: (0, crypto_js_1.encryptText)(tokens.access_token),
                    refreshTokenEncrypted,
                    tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
                    scopes: oauthState.providerConfig.scopes,
                    status: 'connected',
                },
                update: {
                    providerConfigId: oauthState.providerConfigId,
                    email,
                    displayName: profile.data.name,
                    avatarUrl: profile.data.picture,
                    accessTokenEncrypted: (0, crypto_js_1.encryptText)(tokens.access_token),
                    refreshTokenEncrypted,
                    tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
                    scopes: oauthState.providerConfig.scopes,
                    status: 'connected',
                },
            });
            await prisma_js_1.prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date(), userId: user.id } });
            await (0, google_service_js_1.syncGoogleQuota)(account.id).catch(() => undefined);
            const handoffToken = (0, crypto_js_1.randomToken)();
            await prisma_js_1.prisma.authHandoff.create({ data: { userId: user.id, tokenHash: (0, crypto_js_1.hashToken)(handoffToken), expiresAt: new Date(Date.now() + 5 * 60_000) } });
            return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-auth?token=${handoffToken}`);
        }
        if (oauthState.flow !== 'connect' || !oauthState.userId)
            return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' });
        const existingAccount = await prisma_js_1.prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } } });
        const refreshTokenEncrypted = tokens.refresh_token ? (0, crypto_js_1.encryptText)(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted;
        if (!refreshTokenEncrypted)
            return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' });
        const account = await prisma_js_1.prisma.connectedAccount.upsert({
            where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
            create: {
                userId: oauthState.userId,
                providerConfigId: oauthState.providerConfigId,
                provider: 'google_drive',
                providerAccountId,
                email,
                displayName: profile.data.name,
                avatarUrl: profile.data.picture,
                accessTokenEncrypted: (0, crypto_js_1.encryptText)(tokens.access_token),
                refreshTokenEncrypted,
                tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
                scopes: oauthState.providerConfig.scopes,
                status: 'connected',
            },
            update: {
                providerConfigId: oauthState.providerConfigId,
                email,
                displayName: profile.data.name,
                avatarUrl: profile.data.picture,
                accessTokenEncrypted: (0, crypto_js_1.encryptText)(tokens.access_token),
                refreshTokenEncrypted,
                tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
                scopes: oauthState.providerConfig.scopes,
                status: 'connected',
            },
        });
        await prisma_js_1.prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } });
        await (0, google_service_js_1.syncGoogleQuota)(account.id);
        return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-connected?status=success`);
    }
    catch (error) {
        return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-connected?status=error`);
    }
});
exports.connectedAccountRouter.post('/:id/sync-quota', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        const accountId = String(req.params.id);
        const account = await prisma_js_1.prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user.id } });
        const quota = await (0, google_service_js_1.syncGoogleQuota)(account.id);
        return res.json({
            quota: {
                ...quota,
                totalBytes: quota.totalBytes?.toString() ?? null,
                usedBytes: quota.usedBytes.toString(),
                availableBytes: quota.availableBytes?.toString() ?? null,
                trashBytes: quota.trashBytes?.toString() ?? null,
            },
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.connectedAccountRouter.delete('/:id', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        const accountId = String(req.params.id);
        await prisma_js_1.prisma.connectedAccount.updateMany({ where: { id: accountId, userId: req.user.id }, data: { status: 'disconnected' } });
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
