"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const googleapis_1 = require("googleapis");
const zod_1 = require("zod");
const prisma_js_1 = require("../../config/prisma.js");
const env_js_1 = require("../../config/env.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
const password_js_1 = require("../../utils/password.js");
const crypto_js_1 = require("../../utils/crypto.js");
const jwt_js_1 = require("../../utils/jwt.js");
const google_service_js_1 = require("../google/google.service.js");
exports.authRouter = (0, express_1.Router)();
const registerSchema = zod_1.z.object({ name: zod_1.z.string().min(2), email: zod_1.z.string().email(), password: zod_1.z.string().min(8), captchaToken: zod_1.z.string().optional() });
const loginSchema = zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(1) });
const refreshSchema = zod_1.z.object({ refreshToken: zod_1.z.string().min(1) });
const googleExchangeSchema = zod_1.z.object({ token: zod_1.z.string().min(1) });
async function createSession(userId, req) {
    const refreshToken = (0, crypto_js_1.randomToken)();
    const expiresAt = new Date(Date.now() + env_js_1.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const session = await prisma_js_1.prisma.userSession.create({
        data: {
            userId,
            refreshTokenHash: (0, crypto_js_1.hashToken)(refreshToken),
            userAgent: req.header('User-Agent'),
            ipAddress: req.ip,
            expiresAt,
        },
    });
    return { accessToken: (0, jwt_js_1.signAccessToken)({ sub: userId, sid: session.id }), refreshToken };
}
async function verifyCaptcha(token) {
    if (!env_js_1.env.RECAPTCHA_SECRET_KEY)
        return true;
    if (!token)
        return false;
    const form = new URLSearchParams({ secret: env_js_1.env.RECAPTCHA_SECRET_KEY, response: token });
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: form });
    const data = await response.json();
    return Boolean(data.success);
}
exports.authRouter.post('/register', async (req, res, next) => {
    try {
        const body = registerSchema.parse(req.body);
        if (!(await verifyCaptcha(body.captchaToken)))
            return res.status(400).json({ code: 'CAPTCHA_FAILED', message: 'Captcha verification failed.' });
        const existing = await prisma_js_1.prisma.user.findUnique({ where: { email: body.email } });
        if (existing)
            return res.status(409).json({ code: 'AUTH_EMAIL_TAKEN', message: 'Email already registered.' });
        const user = await prisma_js_1.prisma.user.create({ data: { name: body.name, email: body.email, passwordHash: await (0, password_js_1.hashPassword)(body.password) } });
        const tokens = await createSession(user.id, req);
        return res.status(201).json({ ...tokens, user: { id: user.id, name: user.name, email: user.email } });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRouter.post('/login', async (req, res, next) => {
    try {
        const body = loginSchema.parse(req.body);
        const user = await prisma_js_1.prisma.user.findUnique({ where: { email: body.email } });
        if (!user || !(await (0, password_js_1.verifyPassword)(user.passwordHash, body.password)))
            return res.status(401).json({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' });
        const tokens = await createSession(user.id, req);
        return res.json({ ...tokens, user: { id: user.id, name: user.name, email: user.email } });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRouter.get('/google/url', async (_req, res, next) => {
    try {
        const config = await prisma_js_1.prisma.providerConfig.findFirstOrThrow({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } });
        const state = (0, crypto_js_1.randomToken)();
        await prisma_js_1.prisma.oauthState.create({ data: { providerConfigId: config.id, flow: 'login', stateHash: (0, crypto_js_1.hashToken)(state), expiresAt: new Date(Date.now() + 10 * 60_000) } });
        const client = (0, google_service_js_1.createOAuthClient)(config);
        const url = client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'select_account',
            include_granted_scopes: true,
            scope: config.scopes,
            state,
        });
        return res.json({ url });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRouter.get('/google/callback', async (req, res) => {
    try {
        const query = zod_1.z.object({ code: zod_1.z.string(), state: zod_1.z.string() }).parse(req.query);
        const oauthState = await prisma_js_1.prisma.oauthState.findUniqueOrThrow({ where: { stateHash: (0, crypto_js_1.hashToken)(query.state) }, include: { providerConfig: true } });
        if (oauthState.flow !== 'login' || oauthState.usedAt || oauthState.expiresAt < new Date())
            return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-auth?status=error`);
        const client = (0, google_service_js_1.createOAuthClient)(oauthState.providerConfig);
        const tokenResult = await client.getToken(query.code);
        const tokens = tokenResult.tokens;
        if (!tokens.access_token)
            return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-auth?status=error`);
        client.setCredentials(tokens);
        const oauth2 = googleapis_1.google.oauth2({ version: 'v2', auth: client });
        const profile = await oauth2.userinfo.get();
        const providerAccountId = profile.data.id;
        const email = profile.data.email;
        if (!providerAccountId || !email)
            return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-auth?status=error`);
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
    catch {
        return res.redirect(`${env_js_1.env.FRONTEND_URL}/google-auth?status=error`);
    }
});
exports.authRouter.post('/google/exchange', async (req, res, next) => {
    try {
        const body = googleExchangeSchema.parse(req.body);
        const handoff = await prisma_js_1.prisma.authHandoff.findFirst({ where: { tokenHash: (0, crypto_js_1.hashToken)(body.token), usedAt: null, expiresAt: { gt: new Date() } }, include: { user: true } });
        if (!handoff)
            return res.status(401).json({ code: 'AUTH_GOOGLE_HANDOFF_INVALID', message: 'Google login session expired.' });
        await prisma_js_1.prisma.authHandoff.update({ where: { id: handoff.id }, data: { usedAt: new Date() } });
        const tokens = await createSession(handoff.userId, req);
        return res.json({ ...tokens, user: { id: handoff.user.id, name: handoff.user.name, email: handoff.user.email } });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRouter.post('/refresh', async (req, res, next) => {
    try {
        const body = refreshSchema.parse(req.body);
        const session = await prisma_js_1.prisma.userSession.findFirst({ where: { refreshTokenHash: (0, crypto_js_1.hashToken)(body.refreshToken), revokedAt: null, expiresAt: { gt: new Date() } } });
        if (!session)
            return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Refresh token expired.' });
        return res.json({ accessToken: (0, jwt_js_1.signAccessToken)({ sub: session.userId, sid: session.id }) });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRouter.post('/logout', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        await prisma_js_1.prisma.userSession.update({ where: { id: req.user.sessionId }, data: { revokedAt: new Date() } });
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
exports.authRouter.get('/me', auth_middleware_js_1.requireAuth, async (req, res, next) => {
    try {
        const user = await prisma_js_1.prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { id: true, name: true, email: true, status: true } });
        return res.json({ user });
    }
    catch (error) {
        return next(error);
    }
});
