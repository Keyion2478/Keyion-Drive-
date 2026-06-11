"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.folderRouter = void 0;
const express_1 = require("express");
const googleapis_1 = require("googleapis");
const zod_1 = require("zod");
const prisma_js_1 = require("../../config/prisma.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
const google_service_js_1 = require("../google/google.service.js");
exports.folderRouter = (0, express_1.Router)();
exports.folderRouter.use(auth_middleware_js_1.requireAuth);
const defaultFolderColor = '#3b82f6';
const defaultFolderIconUrl = 'https://api.iconify.design/lucide:folder.svg';
const iconUrlSchema = zod_1.z.string().url().startsWith('https://api.iconify.design/lucide:').max(2048);
const colorSchema = zod_1.z.string().regex(/^(#[0-9a-fA-F]{6}|text-[a-z]+-[0-9]+)$/).max(64);
const createSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(255),
    color: colorSchema.optional(),
    iconUrl: iconUrlSchema.nullable().optional(),
    parentId: zod_1.z.string().nullable().optional(),
});
function serializeFolder(folder) {
    return { ...folder, createdAt: folder.createdAt.toISOString(), updatedAt: folder.updatedAt.toISOString() };
}
exports.folderRouter.get('/', async (req, res, next) => {
    try {
        const query = zod_1.z.object({ parentId: zod_1.z.string().nullable().optional(), all: zod_1.z.string().optional() }).parse(req.query);
        const folders = await prisma_js_1.prisma.folder.findMany({
            where: { userId: req.user.id, deletedAt: null, ...(query.all === '1' ? {} : { parentId: query.parentId ?? null }) },
            select: { id: true, name: true, color: true, iconUrl: true, parentId: true, createdAt: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' },
        });
        return res.json({ folders: folders.map(serializeFolder) });
    }
    catch (error) {
        return next(error);
    }
});
exports.folderRouter.get('/recent', async (req, res, next) => {
    try {
        const limit = Math.min(Number(req.query.limit ?? 4), 4);
        const folders = await prisma_js_1.prisma.folder.findMany({
            where: { userId: req.user.id, deletedAt: null },
            select: { id: true, name: true, color: true, iconUrl: true, parentId: true, createdAt: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' },
            take: limit,
        });
        return res.json({ folders: folders.map(serializeFolder) });
    }
    catch (error) {
        return next(error);
    }
});
exports.folderRouter.post('/', async (req, res, next) => {
    try {
        const body = createSchema.parse(req.body);
        if (body.parentId)
            await prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: body.parentId, userId: req.user.id, deletedAt: null } });
        const folder = await prisma_js_1.prisma.folder.create({
            data: { userId: req.user.id, name: body.name, color: body.color ?? defaultFolderColor, iconUrl: body.iconUrl ?? defaultFolderIconUrl, parentId: body.parentId ?? null },
            select: { id: true, name: true, color: true, iconUrl: true, parentId: true, createdAt: true, updatedAt: true },
        });
        return res.status(201).json({ folder: serializeFolder(folder) });
    }
    catch (error) {
        return next(error);
    }
});
exports.folderRouter.patch('/:id', async (req, res, next) => {
    try {
        const body = createSchema.partial().parse(req.body);
        const folderId = String(req.params.id);
        if (body.parentId === folderId)
            return res.status(400).json({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself.' });
        if (body.parentId) {
            await prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: body.parentId, userId: req.user.id, deletedAt: null } });
            const folders = await prisma_js_1.prisma.folder.findMany({ where: { userId: req.user.id, deletedAt: null }, select: { id: true, parentId: true } });
            const descendantIds = new Set([folderId]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const folder of folders) {
                    if (folder.parentId && descendantIds.has(folder.parentId) && !descendantIds.has(folder.id)) {
                        descendantIds.add(folder.id);
                        changed = true;
                    }
                }
            }
            if (descendantIds.has(body.parentId))
                return res.status(400).json({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself or a child folder.' });
        }
        const folder = await prisma_js_1.prisma.folder.updateMany({
            where: { id: folderId, userId: req.user.id, deletedAt: null },
            data: { ...(body.name ? { name: body.name } : {}), ...(body.color ? { color: body.color } : {}), ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}), ...(body.parentId !== undefined ? { parentId: body.parentId } : {}) },
        });
        if (folder.count === 0)
            return res.status(404).json({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' });
        const updated = await prisma_js_1.prisma.folder.findFirstOrThrow({
            where: { id: folderId, userId: req.user.id },
            select: { id: true, name: true, color: true, iconUrl: true, parentId: true, createdAt: true, updatedAt: true },
        });
        return res.json({ folder: serializeFolder(updated) });
    }
    catch (error) {
        return next(error);
    }
});
exports.folderRouter.delete('/:id', async (req, res, next) => {
    try {
        const rootId = String(req.params.id);
        const root = await prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: rootId, userId: req.user.id, deletedAt: null } });
        const folders = await prisma_js_1.prisma.folder.findMany({ where: { userId: req.user.id, deletedAt: null }, select: { id: true, parentId: true } });
        const folderIds = new Set([root.id]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const folder of folders) {
                if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
                    folderIds.add(folder.id);
                    changed = true;
                }
            }
        }
        const files = await prisma_js_1.prisma.file.findMany({ where: { userId: req.user.id, status: 'active', folderId: { in: [...folderIds] } }, include: { connectedAccount: true } });
        const syncedAccountIds = new Set();
        for (const file of files) {
            try {
                const auth = await (0, google_service_js_1.getAuthedGoogleClient)(file.connectedAccount);
                const drive = googleapis_1.google.drive({ version: 'v3', auth });
                await drive.files.delete({ fileId: file.providerFileId });
                syncedAccountIds.add(file.connectedAccountId);
            }
            catch {
                // Keep going so one provider failure does not leave the whole folder undeleted.
            }
        }
        await prisma_js_1.prisma.file.updateMany({ where: { id: { in: files.map((file) => file.id) } }, data: { status: 'deleted', deletedAt: new Date() } });
        await prisma_js_1.prisma.folder.updateMany({ where: { id: { in: [...folderIds] }, userId: req.user.id }, data: { deletedAt: new Date() } });
        for (const accountId of syncedAccountIds)
            await (0, google_service_js_1.syncGoogleQuota)(accountId).catch(() => undefined);
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
