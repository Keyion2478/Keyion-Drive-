"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageRouter = void 0;
const express_1 = require("express");
const prisma_js_1 = require("../../config/prisma.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
exports.storageRouter = (0, express_1.Router)();
exports.storageRouter.use(auth_middleware_js_1.requireAuth);
function bytesToString(value) {
    if (value === null || value === undefined)
        return '0';
    return value.toString();
}
exports.storageRouter.get('/summary', async (req, res, next) => {
    try {
        const accounts = await prisma_js_1.prisma.connectedAccount.findMany({ where: { userId: req.user.id, status: 'connected' }, include: { storageAccount: true } });
        const summary = accounts.reduce((acc, account) => {
            const storage = account.storageAccount;
            acc.totalBytes += storage?.totalBytes ?? 0n;
            acc.usedBytes += storage?.usedBytes ?? 0n;
            acc.availableBytes += storage?.availableBytes ?? 0n;
            return acc;
        }, { totalBytes: 0n, usedBytes: 0n, availableBytes: 0n });
        return res.json({
            totalBytes: summary.totalBytes.toString(),
            usedBytes: summary.usedBytes.toString(),
            availableBytes: summary.availableBytes.toString(),
            accounts: accounts.map((account) => ({
                id: account.id,
                provider: account.provider,
                email: account.email,
                status: account.status,
                totalBytes: account.storageAccount?.totalBytes?.toString() ?? null,
                usedBytes: account.storageAccount?.usedBytes.toString() ?? '0',
                availableBytes: account.storageAccount?.availableBytes?.toString() ?? null,
                lastSyncedAt: account.storageAccount?.lastSyncedAt ?? null,
            })),
        });
    }
    catch (error) {
        return next(error);
    }
});
exports.storageRouter.get('/breakdown', async (req, res, next) => {
    try {
        const rows = await prisma_js_1.prisma.$queryRaw `
      SELECT
        CASE
          WHEN mime_type LIKE 'image/%' THEN 'photo'
          WHEN mime_type LIKE 'video/%' THEN 'video'
          ELSE 'document'
        END AS kind,
        COALESCE(SUM(size_bytes), 0) AS bytes
      FROM files
      WHERE user_id = ${req.user.id} AND status = 'active'
      GROUP BY kind
    `;
        const breakdown = { photo: '0', video: '0', document: '0' };
        for (const row of rows) {
            if (row.kind === 'photo' || row.kind === 'video' || row.kind === 'document')
                breakdown[row.kind] = bytesToString(row.bytes);
        }
        return res.json(breakdown);
    }
    catch (error) {
        return next(error);
    }
});
