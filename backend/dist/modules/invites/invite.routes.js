"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_js_1 = require("../../config/prisma.js");
const auth_middleware_js_1 = require("../../middleware/auth.middleware.js");
exports.inviteRouter = (0, express_1.Router)();
exports.inviteRouter.use(auth_middleware_js_1.requireAuth);
const inviteSchema = zod_1.z.object({ email: zod_1.z.string().email(), role: zod_1.z.enum(['viewer', 'editor']).default('viewer'), targetType: zod_1.z.enum(['file', 'folder']), targetId: zod_1.z.string().min(1) });
async function assertTargetOwner(userId, targetType, targetId) {
    if (targetType === 'file')
        return prisma_js_1.prisma.file.findFirstOrThrow({ where: { id: targetId, userId, status: 'active' } });
    return prisma_js_1.prisma.folder.findFirstOrThrow({ where: { id: targetId, userId, deletedAt: null } });
}
async function resolveTargets(invites) {
    const fileIds = invites.filter((invite) => invite.targetType === 'file').map((invite) => invite.targetId);
    const folderIds = invites.filter((invite) => invite.targetType === 'folder').map((invite) => invite.targetId);
    const [files, folders] = await Promise.all([
        prisma_js_1.prisma.file.findMany({ where: { id: { in: fileIds }, status: 'active' }, select: { id: true, name: true, mimeType: true, sizeBytes: true, folderId: true } }),
        prisma_js_1.prisma.folder.findMany({ where: { id: { in: folderIds }, deletedAt: null }, select: { id: true, name: true } }),
    ]);
    const targets = new Map();
    for (const file of files)
        targets.set(`file:${file.id}`, { id: file.id, name: file.name, type: 'file', mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), folderId: file.folderId });
    for (const folder of folders)
        targets.set(`folder:${folder.id}`, { id: folder.id, name: folder.name, type: 'folder' });
    return targets;
}
function serializeInvite(invite, target, user) {
    return {
        id: invite.id,
        email: invite.inviteeEmail,
        role: invite.role,
        status: invite.status,
        targetType: invite.targetType,
        targetId: invite.targetId,
        target,
        revokedAt: invite.revokedAt?.toISOString() ?? null,
        acceptedAt: invite.acceptedAt?.toISOString() ?? null,
        createdAt: invite.createdAt.toISOString(),
        updatedAt: invite.updatedAt.toISOString(),
        user: user ?? null,
    };
}
exports.inviteRouter.get('/', async (req, res, next) => {
    try {
        const me = await prisma_js_1.prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { email: true } });
        const [sent, received] = await Promise.all([
            prisma_js_1.prisma.workspaceInvite.findMany({ where: { inviterId: req.user.id, revokedAt: null, targetId: { not: '' } }, orderBy: { createdAt: 'desc' } }),
            prisma_js_1.prisma.workspaceInvite.findMany({ where: { inviteeEmail: me.email, revokedAt: null, targetId: { not: '' } }, orderBy: { createdAt: 'desc' } }),
        ]);
        const allInvites = [...sent, ...received];
        const emails = [...new Set(sent.map((invite) => invite.inviteeEmail))];
        const users = await prisma_js_1.prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, name: true, email: true } });
        const userByEmail = new Map(users.map((user) => [user.email, user]));
        const acceptedInvites = sent.filter((invite) => invite.status === 'pending' && userByEmail.has(invite.inviteeEmail));
        if (acceptedInvites.length > 0)
            await prisma_js_1.prisma.workspaceInvite.updateMany({ where: { id: { in: acceptedInvites.map((invite) => invite.id) } }, data: { status: 'accepted', acceptedAt: new Date() } });
        const targetByKey = await resolveTargets(allInvites);
        const sentInvites = sent.map((invite) => serializeInvite({ ...invite, status: userByEmail.has(invite.inviteeEmail) ? 'accepted' : invite.status, acceptedAt: userByEmail.has(invite.inviteeEmail) ? invite.acceptedAt ?? new Date() : invite.acceptedAt }, targetByKey.get(`${invite.targetType}:${invite.targetId}`) ?? null, userByEmail.get(invite.inviteeEmail)));
        const receivedInvites = received.map((invite) => serializeInvite(invite, targetByKey.get(`${invite.targetType}:${invite.targetId}`) ?? null));
        return res.json({ sent: sentInvites, received: receivedInvites, invites: sentInvites });
    }
    catch (error) {
        return next(error);
    }
});
exports.inviteRouter.post('/', async (req, res, next) => {
    try {
        const body = inviteSchema.parse(req.body);
        const email = body.email.trim().toLowerCase();
        const inviter = await prisma_js_1.prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { email: true } });
        if (email === inviter.email)
            return res.status(400).json({ code: 'INVITE_SELF_NOT_ALLOWED', message: 'You cannot invite yourself.' });
        await assertTargetOwner(req.user.id, body.targetType, body.targetId);
        const existingUser = await prisma_js_1.prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } });
        const invite = await prisma_js_1.prisma.workspaceInvite.upsert({
            where: { inviterId_inviteeEmail_targetType_targetId: { inviterId: req.user.id, inviteeEmail: email, targetType: body.targetType, targetId: body.targetId } },
            create: { inviterId: req.user.id, inviteeEmail: email, role: body.role, targetType: body.targetType, targetId: body.targetId, status: existingUser ? 'accepted' : 'pending', acceptedAt: existingUser ? new Date() : null },
            update: { role: body.role, status: existingUser ? 'accepted' : 'pending', acceptedAt: existingUser ? new Date() : null, revokedAt: null },
        });
        const targetByKey = await resolveTargets([invite]);
        return res.status(201).json({ invite: serializeInvite(invite, targetByKey.get(`${invite.targetType}:${invite.targetId}`) ?? null, existingUser) });
    }
    catch (error) {
        return next(error);
    }
});
exports.inviteRouter.delete('/:id', async (req, res, next) => {
    try {
        const result = await prisma_js_1.prisma.workspaceInvite.updateMany({ where: { id: String(req.params.id), inviterId: req.user.id, revokedAt: null }, data: { status: 'revoked', revokedAt: new Date() } });
        if (result.count === 0)
            return res.status(404).json({ code: 'INVITE_NOT_FOUND', message: 'Invite not found.' });
        return res.json({ status: 'ok' });
    }
    catch (error) {
        return next(error);
    }
});
