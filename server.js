// 1. Importation des modules
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config(); // Charge les variables du fichier .env

const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const ADMIN_EMAILS = ["martin.stuis11@gmail.com", "terra.ophis@gmail.com"];

// //////////////////////////////////////////////////
// 🛡️ MIDDLEWARE DE SÉCURITÉ ADMIN
// //////////////////////////////////////////////////
const verifyAdmin = async (req, res, next) => {
    // 1. On vérifie si un token est présent dans l'en-tête de la requête
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Accès refusé : Token d'authentification manquant." });
    }

    // 2. On extrait le token (en enlevant le mot "Bearer ")
    const idToken = authHeader.split('Bearer ')[1];

    try {
        // 3. On demande à Firebase de vérifier si le token est authentique et non expiré
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // 4. VÉRIFICATION ULTIME : Est-ce que c'est bien l'administrateur ?
        if (!ADMIN_EMAILS.includes(decodedToken.email)) {
            console.warn(`Tentative d'accès non autorisé par : ${decodedToken.email}`);
            return res.status(403).json({ error: "Accès interdit : Droits administrateur requis." });
        }

        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("Erreur de validation du token :", error.message);
        return res.status(401).json({ error: "Token invalide ou expiré." });
    }
};

// Initialisation Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
    }
});

// Configuration Cloudflare R2
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
});

// Configuration Multer (stockage temporaire en mémoire RAM, images uniquement)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 2. Initialisation de l'application
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Hébergement derrière un proxy : req.ip = IP réelle du visiteur

// Route Webhook Stripe (doit recevoir le corps brut, donc AVANT express.json)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Erreur de signature Webhook :', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.client_reference_id;

        if (session.payment_status !== 'paid') {
            console.warn(`Session ${session.id} terminée mais non payée (${session.payment_status}).`);
            return res.json({ received: true });
        }

        // Depuis l'API Stripe 2025 ("basil"), l'adresse est dans collected_information
        const shipping = session.collected_information?.shipping_details || session.shipping_details;
        const customer = session.customer_details;

        try {
            const orderRef = db.collection('orders').doc(orderId);

            // Transaction : évite de déduire deux fois le stock si Stripe renvoie l'événement
            await db.runTransaction(async (t) => {
                const orderSnap = await t.get(orderRef);
                if (!orderSnap.exists) return console.error(`Commande ${orderId} introuvable`);
                const orderData = orderSnap.data();
                if (orderData.status !== 'En attente de paiement') return; // Déjà traitée

                const items = orderData.items || [];
                const productSnaps = await Promise.all(items.map(item => t.get(db.collection('products').doc(item.id))));

                productSnaps.forEach((snap, i) => {
                    if (snap.exists) {
                        t.update(snap.ref, { stock: admin.firestore.FieldValue.increment(-items[i].quantity) });
                    }
                });

                t.update(orderRef, {
                    status: 'Payé',
                    amountPaid: session.amount_total / 100,
                    paymentDate: admin.firestore.FieldValue.serverTimestamp(),
                    customerEmail: customer?.email || 'Non renseigné',
                    customerName: shipping?.name || customer?.name || 'Inconnu',
                    customerPhone: customer?.phone || '',
                    shippingAddress: shipping ? {
                        line1: shipping.address.line1,
                        line2: shipping.address.line2 || '',
                        city: shipping.address.city,
                        postalCode: shipping.address.postal_code,
                        country: shipping.address.country
                    } : null
                });
            });

            console.log(`✅ Paiement Stripe validé pour la commande : ${orderId}`);
        } catch (e) {
            console.error("Erreur lors du traitement Firestore du Webhook :", e);
            // 500 => Stripe réessaiera plus tard
            return res.status(500).json({ error: "Erreur de traitement" });
        }
    }
    res.json({ received: true });
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Création de la commande + session de paiement.
// Les prix sont TOUJOURS recalculés ici depuis Firestore : le client n'envoie que les ids et quantités.
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const cart = Array.isArray(req.body.items) ? req.body.items : [];
        if (cart.length === 0 || cart.length > 50) {
            return res.status(400).json({ error: "Panier vide ou invalide." });
        }

        const items = [];
        for (const { id, quantity } of cart) {
            const qty = parseInt(quantity, 10);
            if (typeof id !== 'string' || !id || !(qty > 0)) {
                return res.status(400).json({ error: "Panier invalide." });
            }
            const snap = await db.collection('products').doc(id).get();
            const p = snap.exists ? snap.data() : null;
            if (!p || p.hidden) {
                return res.status(409).json({ error: "Un article de votre panier n'est plus disponible. Merci de le retirer." });
            }
            if ((p.stock || 0) < qty) {
                return res.status(409).json({ error: `Stock insuffisant pour « ${p.name} » (${p.stock || 0} disponible(s)).` });
            }
            items.push({ id, name: p.name, price: Number(p.price), quantity: qty, photo: p.photos?.[0] || null });
        }

        const amountValue = Math.round(items.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100) / 100;
        if (amountValue <= 0) {
            return res.status(400).json({ error: "Aucun montant à régler pour cette commande." });
        }

        const orderRef = await db.collection('orders').add({
            items: items.map(({ photo, ...item }) => item),
            amountValue,
            status: 'En attente de paiement',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        let clientUrl = process.env.CLIENT_URL || req.headers.origin || 'http://localhost:3000';
        if (clientUrl.endsWith('/')) clientUrl = clientUrl.slice(0, -1);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            client_reference_id: orderRef.id,
            shipping_address_collection: {
                allowed_countries: ['FR', 'BE', 'CH', 'LU'],
            },
            phone_number_collection: { enabled: true },
            line_items: items.map(item => ({
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: item.name,
                        ...(item.photo ? { images: [item.photo] } : {})
                    },
                    unit_amount: Math.round(item.price * 100),
                },
                quantity: item.quantity,
            })),
            mode: 'payment',
            success_url: `${clientUrl}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${clientUrl}/boutique`,
        });

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error("Erreur Stripe Checkout :", error.message || error);
        res.status(500).json({ error: "Impossible de créer la session de paiement. Réessayez dans un instant." });
    }
});

app.get('/api/ping', (req, res) => {
    res.send('API Terraophis en ligne ! 🚀');
});

app.post('/api/upload', verifyAdmin, upload.array('photos', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "Aucune image reçue." });
        }

        let folderName = req.body.folderName || 'products';
        folderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');

        const uploadPromises = req.files.map(async (file) => {
            const baseName = file.originalname.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
            const basePath = `${folderName}/${Date.now()}-${baseName}.jpg`;

            // Sharp optimise le poids de l'image pour le web
            const buffer = await sharp(file.buffer)
                .rotate()
                .resize({ width: 1200, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            await s3.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: basePath,
                Body: buffer,
                ContentType: 'image/jpeg'
            }));

            return { url: `${process.env.R2_PUBLIC_URL}/${basePath}`, path: basePath };
        });

        const uploadedData = await Promise.all(uploadPromises);
        res.status(200).json({ message: "Upload réussi", files: uploadedData });

    } catch (error) {
        console.error("Erreur d'upload :", error);
        res.status(500).json({ error: "Erreur lors de l'upload des images." });
    }
});

// Suppression définitive de fichiers sur Cloudflare R2
app.post('/api/delete', verifyAdmin, async (req, res) => {
    try {
        const { keys } = req.body; // Attend un tableau de chemins complets
        if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ error: "Aucune clé fournie" });

        await s3.send(new DeleteObjectsCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: { Objects: keys.map(key => ({ Key: key })) }
        }));
        res.status(200).json({ message: "Fichiers supprimés de Cloudflare avec succès" });
    } catch (error) {
        console.error("Erreur suppression Cloudflare :", error);
        res.status(500).json({ error: "Erreur lors de la suppression sur les serveurs" });
    }
});

// Formulaire de contact du footer : envoie uniquement vers la boîte de la boutique
// ponytail: anti-spam en mémoire (perdu au redémarrage, par instance) — passer à un captcha si le spam devient un problème
const contactHits = new Map();
app.post('/api/contact', async (req, res) => {
    const { name, email, message, website } = req.body;
    if (website) return res.status(200).json({ message: "ok" }); // Champ piège rempli par les robots

    if (!name || !email || !message || !/^\S+@\S+\.\S+$/.test(email) || message.length > 5000 || name.length > 200) {
        return res.status(400).json({ error: "Merci de remplir correctement tous les champs." });
    }

    const now = Date.now();
    const hits = (contactHits.get(req.ip) || []).filter(t => now - t < 60 * 60 * 1000);
    if (hits.length >= 5) return res.status(429).json({ error: "Trop de messages envoyés. Réessayez plus tard." });
    contactHits.set(req.ip, [...hits, now]);

    try {
        await transporter.sendMail({
            from: `"Site Terraophis" <${process.env.SMTP_EMAIL}>`,
            to: process.env.CONTACT_EMAIL || process.env.SMTP_EMAIL,
            replyTo: email,
            subject: `Nouveau message de ${name.slice(0, 80)}`,
            html: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) a écrit :</p><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`
        });
        res.status(200).json({ message: "Message envoyé" });
    } catch (error) {
        console.error("Erreur SMTP contact :", error);
        res.status(500).json({ error: "L'envoi a échoué. Écrivez-nous directement à terra.ophis@gmail.com." });
    }
});

// 5. Allumage du serveur
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré avec succès sur http://localhost:${PORT}`);
});
