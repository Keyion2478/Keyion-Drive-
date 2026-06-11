"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_js_1 = require("../config/prisma.js");
const crypto_js_1 = require("../utils/crypto.js");
const scopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];
async function main() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/connected-accounts/google/callback';
    if (!clientId || !clientSecret)
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.');
    await prisma_js_1.prisma.providerConfig.updateMany({
        where: { userId: null, provider: 'google_drive', status: 'active' },
        data: { status: 'disabled' },
    });
    const config = await prisma_js_1.prisma.providerConfig.create({
        data: {
            userId: null,
            provider: 'google_drive',
            clientIdEncrypted: (0, crypto_js_1.encryptText)(clientId),
            clientSecretEncrypted: (0, crypto_js_1.encryptText)(clientSecret),
            redirectUri,
            scopes,
            status: 'active',
        },
    });
    console.log(`Seeded global Google Drive config: ${config.id}`);
}
main()
    .catch((error) => {
    console.error(error);
    process.exit(1);
})
    .finally(async () => {
    await prisma_js_1.prisma.$disconnect();
});
