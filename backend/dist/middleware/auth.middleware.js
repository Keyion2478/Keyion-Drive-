"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const prisma_js_1 = require("../config/prisma.js");
const jwt_js_1 = require("../utils/jwt.js");
async function requireAuth(req, res, next) {
    try {
        const header = req.header('Authorization');
        if (!header?.startsWith('Bearer '))
            return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' });
        const payload = (0, jwt_js_1.verifyAccessToken)(header.slice(7));
        const session = await prisma_js_1.prisma.userSession.findUnique({ where: { id: payload.sid } });
        if (!session || session.revokedAt || session.expiresAt < new Date())
            return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expired.' });
        req.user = { id: payload.sub, sessionId: payload.sid };
        return next();
    }
    catch {
        return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' });
    }
}
