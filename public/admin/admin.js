import { db, auth } from '../firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, serverTimestamp, query, orderBy, increment, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const ADMIN_EMAILS = ["martin.stuis11@gmail.com", "terra.ophis@gmail.com"];
const PLACEHOLDER_IMG = '/assets/img/logo_carre.png';
const LOW_STOCK = 2; // Seuil d'alerte "stock faible"
const MAX_PHOTOS = 5;

const CATEGORIES = {
    cloportes: 'Isopodes (Cloportes)',
    iules: 'Iules',
    coleopteres: 'Coléoptères',
    mantes: 'Mantes',
    phasmes: 'Phasmes',
    accessoires: 'Accessoires',
};
const STATUSES = ['En attente de paiement', 'Payé', 'En préparation', 'Expédié', 'Annulé'];
const PAID_STATUSES = ['Payé', 'En préparation', 'Expédié'];
const TODO_STATUSES = ['Payé', 'En préparation'];

let products = [];
let orders = [];
let guides = [];
let editProductId = null;
let editorPhotos = []; // URLs des photos conservées dans l'éditeur produit
let editGuideId = null;
let orderFilter = 'todo';

// --- OUTILS ---

const $ = (id) => document.getElementById(id);
const esc = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatPrice = (n) => Number(n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const formatDate = (ts) => ts?.toDate ? ts.toDate().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const shortId = (id) => id.slice(0, 6).toUpperCase();
const isOnSale = (p) => Number(p.compareAtPrice) > Number(p.price);
const isLow = (p) => !p.hidden && (p.stock || 0) <= LOW_STOCK;

function toast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

async function authFetch(url, options = {}) {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(url, { ...options, headers: { ...options.headers, 'Authorization': `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur serveur (${res.status})`);
    return data;
}

async function uploadImages(files) {
    const uploadData = new FormData();
    [...files].forEach(f => uploadData.append('photos', f));
    const { files: uploaded } = await authFetch('/api/upload', { method: 'POST', body: uploadData });
    return uploaded.map(f => f.url);
}

// Supprime des images sur R2, sauf celles encore utilisées par un produit (ex : produit dupliqué)
async function deleteImages(urls) {
    const used = new Set(products.flatMap(p => p.photos || []));
    const keys = urls.filter(u => u && !used.has(u)).map(u => new URL(u).pathname.substring(1));
    if (keys.length === 0) return;
    await authFetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys })
    }).catch(err => console.error("Nettoyage R2 :", err));
}

// --- SÉCURITÉ & AUTHENTIFICATION ---

onAuthStateChanged(auth, (user) => {
    if (!user) {
        window.location.href = "/login";
        return;
    }
    if (!ADMIN_EMAILS.includes(user.email)) {
        console.warn("Accès refusé pour :", user.email);
        window.location.href = "/login?error=forbidden";
        return;
    }
    document.body.classList.remove('is-loading');
    loadProducts();
    loadOrders();
    loadSliderPreview();
    loadGridPreviews();
    loadGuides();
});

$('btnLogout').addEventListener('click', () => signOut(auth));

// --- ONGLETS ---

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.hidden = tab.id !== tabId);
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
    history.replaceState(null, '', '#' + tabId.replace('tab-', ''));
    window.scrollTo(0, 0);
}

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// Raccourcis du tableau de bord vers un onglet filtré
document.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.orderFilter) {
        orderFilter = el.dataset.orderFilter;
        renderOrders();
    }
    if (el.dataset.productFilter) {
        $('productStateFilter').value = el.dataset.productFilter;
        renderInventory();
    }
    switchTab(el.dataset.goto);
}));

if ($('tab-' + location.hash.slice(1))) switchTab('tab-' + location.hash.slice(1));

document.querySelectorAll('dialog [data-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog').close()));

// --- TABLEAU DE BORD ---

function renderDashboard() {
    const todo = orders.filter(o => TODO_STATUSES.includes(o.status));
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const recentPaid = orders.filter(o => PAID_STATUSES.includes(o.status) && ((o.paymentDate || o.createdAt)?.toMillis?.() || 0) >= since);
    const online = products.filter(p => !p.hidden);
    const low = products.filter(isLow).sort((a, b) => (a.stock || 0) - (b.stock || 0));

    $('statTodo').textContent = todo.length;
    $('statRevenue').textContent = formatPrice(recentPaid.reduce((sum, o) => sum + (o.amountPaid ?? o.amountValue ?? 0), 0));
    $('statRevenueSub').textContent = `${recentPaid.length} commande(s) payée(s)`;
    $('statOnline').textContent = online.length;
    $('statOnlineSub').textContent = `${products.length - online.length} masqué(s)`;
    $('statLow').textContent = low.length;

    $('dashOrders').innerHTML = todo.slice(0, 6).map(o => `
        <button class="compact-item" data-goto-order="${o.id}">
            <span class="grow"><strong>#${shortId(o.id)}</strong> ${esc(o.customerName || '')}<small class="muted">${formatDate(o.paymentDate || o.createdAt)}</small></span>
            <span class="status-pill ${statusClass(o.status)}">${esc(o.status)}</span>
            <strong>${formatPrice(o.amountValue)}</strong>
        </button>
    `).join('') || '<p class="empty">Rien à préparer pour le moment 🌿</p>';

    $('dashStock').innerHTML = low.slice(0, 8).map(p => `
        <div class="compact-item" data-id="${p.id}">
            <img class="thumb sm" src="${esc(p.photos?.[0] || PLACEHOLDER_IMG)}" alt="">
            <span class="grow">${esc(p.name)}</span>
            ${stepperHtml(p)}
        </div>
    `).join('') || '<p class="empty">Tous les stocks sont bons.</p>';
}

$('dashOrders').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-goto-order]');
    if (!btn) return;
    orderFilter = 'todo';
    $('orderSearch').value = '';
    renderOrders();
    switchTab('tab-commandes');
    const card = document.querySelector(`.order-card[data-id="${btn.dataset.gotoOrder}"]`);
    card?.scrollIntoView({ block: 'center' });
    card?.classList.add('flash');
});

// --- PRODUITS ---

const productDialog = $('productDialog');
const productForm = $('productForm');
const categoryOptions = Object.entries(CATEGORIES).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
productForm.elements['category'].innerHTML = '<option value="" disabled selected>Choisir…</option>' + categoryOptions;
$('productCategoryFilter').insertAdjacentHTML('beforeend', categoryOptions);

async function loadProducts() {
    $('adminInventory').innerHTML = '<p class="empty">Chargement des produits…</p>';
    try {
        const snap = await getDocs(query(collection(db, "products"), orderBy("createdAt", "desc")));
        products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        refreshProducts();
    } catch (error) {
        console.error("Erreur de chargement des produits :", error);
        $('adminInventory').innerHTML = '<p class="empty">Erreur lors du chargement des produits.</p>';
    }
}

function refreshProducts() {
    renderInventory();
    renderDashboard();
}

const stepperHtml = (p) => {
    const stock = p.stock || 0;
    return `
        <div class="stepper ${stock <= 0 ? 'out' : stock <= LOW_STOCK ? 'low' : ''}">
            <button data-action="stock" data-delta="-1" aria-label="Retirer 1 du stock" ${stock <= 0 ? 'disabled' : ''}>−</button>
            <span>${stock}</span>
            <button data-action="stock" data-delta="1" aria-label="Ajouter 1 au stock">+</button>
        </div>`;
};

function renderInventory() {
    const term = $('productSearch').value.toLowerCase().trim();
    const cat = $('productCategoryFilter').value;
    const state = $('productStateFilter').value;
    const stateFilters = {
        all: () => true,
        visible: p => !p.hidden,
        hidden: p => p.hidden,
        low: isLow,
        sale: isOnSale,
    };

    const list = products.filter(p =>
        (!term || `${p.name} ${p.latinName}`.toLowerCase().includes(term)) &&
        (cat === 'all' || p.category === cat) &&
        stateFilters[state](p)
    );

    $('productCount').textContent = list.length === products.length ? `(${products.length})` : `(${list.length} / ${products.length})`;
    $('adminInventory').innerHTML = list.map(p => `
        <div class="product-row ${p.hidden ? 'is-hidden' : ''}" data-id="${p.id}">
            <img src="${esc(p.photos?.[0] || PLACEHOLDER_IMG)}" alt="" class="thumb">
            <div class="product-main">
                <strong>${esc(p.name)}</strong>
                <em>${esc(p.latinName)}</em>
                <div class="badges">
                    ${p.hidden ? '<span class="badge">Masqué</span>' : ''}
                    ${isOnSale(p) ? '<span class="badge sale">Promo</span>' : ''}
                </div>
            </div>
            <span class="cell-cat">${esc(CATEGORIES[p.category] || p.category || '—')}</span>
            <span class="cell-price">${isOnSale(p) ? `<s>${formatPrice(p.compareAtPrice)}</s>` : ''}${formatPrice(p.price)}</span>
            ${stepperHtml(p)}
            <label class="switch" title="${p.hidden ? 'Masqué : cliquer pour publier' : 'En ligne : cliquer pour masquer'}">
                <input type="checkbox" data-action="visibility" ${p.hidden ? '' : 'checked'} aria-label="Visible dans la boutique">
                <span></span>
            </label>
            <div class="row-actions">
                <button data-action="edit">Modifier</button>
                <button data-action="duplicate">Dupliquer</button>
                <a href="/produit?id=${p.id}" target="_blank">Voir</a>
                <button data-action="delete" class="danger">Supprimer</button>
            </div>
        </div>
    `).join('') || '<p class="empty">Aucun produit ne correspond.</p>';
}

$('productSearch').addEventListener('input', renderInventory);
$('productCategoryFilter').addEventListener('change', renderInventory);
$('productStateFilter').addEventListener('change', renderInventory);
$('btnNewProduct').addEventListener('click', () => openProductEditor());

async function handleProductAction(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const p = products.find(x => x.id === el.closest('[data-id]').dataset.id);
    if (!p) return;

    switch (el.dataset.action) {
        case 'stock': return changeStock(p, Number(el.dataset.delta));
        case 'visibility': return setVisibility(p, !el.checked);
        case 'edit': return openProductEditor(p);
        case 'duplicate': return duplicateProduct(p);
        case 'delete': return deleteProduct(p);
    }
}
$('adminInventory').addEventListener('click', handleProductAction);
$('dashStock').addEventListener('click', handleProductAction);

async function changeStock(p, delta) {
    if ((p.stock || 0) + delta < 0) return;
    try {
        // increment() évite d'écraser une vente validée entre-temps par le webhook
        await updateDoc(doc(db, "products", p.id), { stock: increment(delta) });
        p.stock = (p.stock || 0) + delta;
        refreshProducts();
    } catch (error) {
        console.error(error);
        toast("Impossible de modifier le stock.", 'error');
    }
}

async function setVisibility(p, hidden) {
    try {
        await updateDoc(doc(db, "products", p.id), { hidden });
        p.hidden = hidden;
        refreshProducts();
        toast(hidden ? `« ${p.name} » est masqué de la boutique` : `« ${p.name} » est en ligne`);
    } catch (error) {
        console.error(error);
        toast("Impossible de changer la visibilité.", 'error');
        refreshProducts();
    }
}

async function duplicateProduct(p) {
    const { id, createdAt, ...data } = p;
    const copy = { ...data, name: `${p.name} (copie)`, hidden: true };
    try {
        const ref = await addDoc(collection(db, "products"), { ...copy, createdAt: serverTimestamp() });
        products.unshift({ id: ref.id, ...copy });
        refreshProducts();
        toast("Copie créée (masquée) : modifiez-la puis publiez-la");
        openProductEditor(products[0]);
    } catch (error) {
        console.error(error);
        toast("Impossible de dupliquer le produit.", 'error');
    }
}

async function deleteProduct(p) {
    if (!confirm(`Supprimer définitivement « ${p.name} » et ses photos ?\n\nAstuce : pour le retirer temporairement de la boutique, masquez-le plutôt.`)) return;
    try {
        await deleteDoc(doc(db, "products", p.id));
        products = products.filter(x => x.id !== p.id);
        refreshProducts();
        await deleteImages(p.photos || []);
        toast("Produit supprimé");
    } catch (error) {
        console.error("Erreur lors de la suppression :", error);
        toast("Erreur lors de la suppression du produit.", 'error');
    }
}

function openProductEditor(p = null) {
    productForm.reset();
    editProductId = p?.id || null;
    editorPhotos = [...(p?.photos || [])];
    $('productDialogTitle').textContent = p ? 'Modifier le produit' : 'Nouveau produit';

    if (p) {
        const f = productForm.elements;
        f['name'].value = p.name || '';
        f['latinName'].value = p.latinName || '';
        f['price'].value = p.price ?? '';
        f['compareAtPrice'].value = p.compareAtPrice || '';
        f['stock'].value = p.stock ?? 0;
        f['category'].value = p.category || '';
        f['difficulty'].value = p.difficulty || '';
        f['description'].value = p.description || '';
        f['hidden'].checked = !!p.hidden;
    }

    renderEditorPhotos();
    productDialog.showModal();
}

function renderEditorPhotos() {
    $('editorPhotos').innerHTML = editorPhotos.map((url, i) => `
        <div class="editor-photo">
            <img src="${esc(url)}" alt="">
            ${i === 0 ? '<span class="cover-tag">Vignette</span>' : ''}
            <div class="thumb-controls">
                <button type="button" data-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Déplacer à gauche">‹</button>
                <button type="button" data-remove data-i="${i}" class="danger" aria-label="Retirer">×</button>
                <button type="button" data-move="1" data-i="${i}" ${i === editorPhotos.length - 1 ? 'disabled' : ''} aria-label="Déplacer à droite">›</button>
            </div>
        </div>
    `).join('') || '<p class="muted">Aucune photo pour l\'instant.</p>';
}

$('editorPhotos').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if ('remove' in btn.dataset) {
        editorPhotos.splice(i, 1);
    } else {
        const j = i + Number(btn.dataset.move);
        [editorPhotos[i], editorPhotos[j]] = [editorPhotos[j], editorPhotos[i]];
    }
    renderEditorPhotos();
});

productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnSubmit');
    const files = $('productFiles').files;
    const f = new FormData(productForm);

    if (editorPhotos.length + files.length > MAX_PHOTOS) return toast(`${MAX_PHOTOS} photos maximum par produit.`, 'error');
    if (editorPhotos.length + files.length === 0) return toast("Ajoutez au moins une photo.", 'error');

    try {
        btn.disabled = true;
        btn.textContent = files.length > 0 ? "Envoi des photos…" : "Enregistrement…";

        const newUrls = files.length > 0 ? await uploadImages(files) : [];
        const price = parseFloat(f.get('price'));
        const compareAtPrice = parseFloat(f.get('compareAtPrice'));

        const productData = {
            name: f.get('name').trim(),
            latinName: f.get('latinName').trim(),
            price,
            compareAtPrice: compareAtPrice > price ? compareAtPrice : null,
            stock: parseInt(f.get('stock'), 10),
            category: f.get('category'),
            difficulty: f.get('difficulty'),
            description: f.get('description'),
            hidden: f.get('hidden') === 'on',
            photos: [...editorPhotos, ...newUrls],
        };

        if (editProductId) {
            const p = products.find(x => x.id === editProductId);
            const removedPhotos = (p.photos || []).filter(url => !productData.photos.includes(url));
            await updateDoc(doc(db, "products", editProductId), productData);
            Object.assign(p, productData);
            deleteImages(removedPhotos);
            toast("Produit mis à jour");
        } else {
            const ref = await addDoc(collection(db, "products"), { ...productData, createdAt: serverTimestamp() });
            products.unshift({ id: ref.id, ...productData });
            toast(productData.hidden ? "Produit créé (masqué)" : "Produit publié");
        }

        productDialog.close();
        refreshProducts();
    } catch (err) {
        console.error(err);
        toast("Erreur : " + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = "Enregistrer";
    }
});

// --- COMMANDES ---

const statusClass = (s) => ({ 'En attente de paiement': 'pending', 'Payé': 'paid', 'En préparation': 'prep', 'Expédié': 'shipped', 'Annulé': 'cancelled' }[s] || '');

const ORDER_FILTERS = [
    ['todo', 'À traiter', o => TODO_STATUSES.includes(o.status)],
    ['all', 'Toutes', () => true],
    ...STATUSES.map(s => [s, s, o => o.status === s]),
];

async function loadOrders() {
    $('adminOrders').innerHTML = '<p class="empty">Chargement des commandes…</p>';
    try {
        const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
        orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderOrders();
        renderDashboard();
    } catch (error) {
        console.error("Erreur de chargement des commandes :", error);
        $('adminOrders').innerHTML = '<p class="empty">Erreur lors du chargement des commandes.</p>';
    }
}

function orderCard(o) {
    const itemsHtml = (o.items || []).map(item => {
        const name = item.name || products.find(p => p.id === item.id)?.name || 'Produit supprimé';
        return `<li><span>${item.quantity} × ${esc(name)}</span>${item.price != null ? `<span>${formatPrice(item.price * item.quantity)}</span>` : ''}</li>`;
    }).join('');

    const a = o.shippingAddress;
    const addressText = a ? [o.customerName, a.line1, a.line2, `${a.postalCode} ${a.city}`, a.country].filter(Boolean).join('\n') : '';
    const hasEmail = o.customerEmail && o.customerEmail !== 'Non renseigné';
    const mailBody = `Bonjour,\n\nVotre commande Terraophis #${shortId(o.id)} a été expédiée` + (o.trackingNumber ? ` (n° de suivi : ${o.trackingNumber})` : '') + `.\n\nMerci pour votre confiance !`;
    const mailto = `mailto:${o.customerEmail}?subject=${encodeURIComponent(`Votre commande Terraophis #${shortId(o.id)}`)}&body=${encodeURIComponent(mailBody)}`;

    return `
        <article class="order-card" data-id="${o.id}">
            <header class="order-card-header">
                <div>
                    <span class="order-id">#${shortId(o.id)}</span>
                    <span class="order-date">${formatDate(o.createdAt)}</span>
                    ${o.customerName ? `<span class="order-customer">${esc(o.customerName)}</span>` : ''}
                </div>
                <div class="order-head-right">
                    <strong>${formatPrice(o.amountValue)}</strong>
                    <select class="status-select ${statusClass(o.status)}" data-action="status" aria-label="Statut">
                        ${STATUSES.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                </div>
            </header>
            <div class="order-card-body">
                <div class="order-col">
                    <h4>Contenu du colis</h4>
                    <ul class="order-items">${itemsHtml}</ul>
                </div>
                <div class="order-col">
                    <h4>Livraison</h4>
                    ${a ? `
                        <p class="order-address-text">${esc(addressText).replace(/\n/g, '<br>')}</p>
                        <button class="btn-link" data-action="copy-address" data-address="${esc(addressText)}">Copier l'adresse</button>
                    ` : '<p class="muted">Pas d\'adresse (paiement non finalisé).</p>'}
                    ${hasEmail ? `<p class="order-contact"><a href="mailto:${esc(o.customerEmail)}">${esc(o.customerEmail)}</a></p>` : ''}
                    ${o.customerPhone ? `<p class="order-contact">${esc(o.customerPhone)}</p>` : ''}
                </div>
                <div class="order-col">
                    <h4>Suivi</h4>
                    <input type="text" data-field="trackingNumber" placeholder="N° de suivi du colis" value="${esc(o.trackingNumber || '')}">
                    <textarea data-field="adminNote" rows="2" placeholder="Note interne">${esc(o.adminNote || '')}</textarea>
                    <div class="order-followup-actions">
                        <button class="btn-ghost" data-action="save-followup">Enregistrer</button>
                        ${hasEmail ? `<a class="btn-link" href="${esc(mailto)}">Prévenir le client</a>` : ''}
                        ${PAID_STATUSES.includes(o.status) ? '' : '<button class="btn-link danger" data-action="delete-order">Supprimer</button>'}
                    </div>
                </div>
            </div>
        </article>`;
}

function renderOrders() {
    const term = $('orderSearch').value.toLowerCase().trim();

    $('orderFilters').innerHTML = ORDER_FILTERS.map(([key, label, fn]) =>
        `<button class="chip ${key === orderFilter ? 'active' : ''}" data-filter="${esc(key)}">${esc(label)} <span>${orders.filter(fn).length}</span></button>`
    ).join('');

    const filterFn = ORDER_FILTERS.find(([key]) => key === orderFilter)[2];
    const list = orders.filter(filterFn).filter(o => !term ||
        [o.id, o.customerName, o.customerEmail, o.shippingAddress?.city].join(' ').toLowerCase().includes(term));

    $('adminOrders').innerHTML = list.map(orderCard).join('') || '<p class="empty">Aucune commande ici.</p>';

    const todoCount = orders.filter(o => TODO_STATUSES.includes(o.status)).length;
    $('badgeOrders').hidden = todoCount === 0;
    $('badgeOrders').textContent = todoCount;
}

$('orderSearch').addEventListener('input', renderOrders);
$('orderFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    orderFilter = chip.dataset.filter;
    renderOrders();
});

$('adminOrders').addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'status') return;
    const o = orders.find(x => x.id === e.target.closest('[data-id]').dataset.id);
    updateOrderStatus(o, e.target.value, e.target);
});

$('adminOrders').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'SELECT') return;
    const card = el.closest('[data-id]');
    const o = orders.find(x => x.id === card.dataset.id);

    try {
        if (el.dataset.action === 'copy-address') {
            await navigator.clipboard.writeText(el.dataset.address);
            toast("Adresse copiée");
        } else if (el.dataset.action === 'save-followup') {
            const data = {
                trackingNumber: card.querySelector('[data-field="trackingNumber"]').value.trim(),
                adminNote: card.querySelector('[data-field="adminNote"]').value.trim(),
            };
            await updateDoc(doc(db, "orders", o.id), data);
            Object.assign(o, data);
            renderOrders();
            toast("Suivi enregistré");
        } else if (el.dataset.action === 'delete-order') {
            if (!confirm(`Supprimer la commande #${shortId(o.id)} ?`)) return;
            await deleteDoc(doc(db, "orders", o.id));
            orders = orders.filter(x => x.id !== o.id);
            renderOrders();
            renderDashboard();
            toast("Commande supprimée");
        }
    } catch (error) {
        console.error(error);
        toast("L'opération a échoué.", 'error');
    }
});

async function updateOrderStatus(o, status, select) {
    // Annuler une commande payée : proposer de remettre les articles en stock
    const restock = status === 'Annulé' && PAID_STATUSES.includes(o.status)
        && confirm("Remettre les articles de cette commande en stock ?");

    try {
        const batch = writeBatch(db);
        batch.update(doc(db, "orders", o.id), { status });
        const restockItems = restock ? (o.items || []).filter(i => products.some(p => p.id === i.id)) : [];
        restockItems.forEach(i => batch.update(doc(db, "products", i.id), { stock: increment(i.quantity) }));
        await batch.commit();

        restockItems.forEach(i => {
            const p = products.find(x => x.id === i.id);
            p.stock = (p.stock || 0) + i.quantity;
        });
        o.status = status;
        renderOrders();
        refreshProducts();
        toast(`Commande #${shortId(o.id)} : ${status}${restockItems.length ? ' (stock remis)' : ''}`);
    } catch (error) {
        console.error("Erreur mise à jour statut :", error);
        select.value = o.status;
        toast("Erreur lors de la mise à jour du statut.", 'error');
    }
}

// Chaque clic sur "Valider la commande" crée une commande : on nettoie celles jamais payées
$('btnPurgeAbandoned').addEventListener('click', async () => {
    const limit = Date.now() - 24 * 3600 * 1000;
    const abandoned = orders.filter(o => o.status === 'En attente de paiement' && (o.createdAt?.toMillis?.() || 0) < limit);
    if (abandoned.length === 0) return toast("Aucun panier abandonné à nettoyer.");
    if (!confirm(`Supprimer ${abandoned.length} commande(s) jamais payée(s) de plus de 24 h ?`)) return;

    try {
        for (let i = 0; i < abandoned.length; i += 400) { // Un batch Firestore est limité à 500 opérations
            const batch = writeBatch(db);
            abandoned.slice(i, i + 400).forEach(o => batch.delete(doc(db, "orders", o.id)));
            await batch.commit();
        }
        orders = orders.filter(o => !abandoned.includes(o));
        renderOrders();
        renderDashboard();
        toast(`${abandoned.length} panier(s) abandonné(s) supprimé(s)`);
    } catch (error) {
        console.error(error);
        toast("Erreur lors du nettoyage.", 'error');
        loadOrders();
    }
});

// --- AFFICHAGE : SLIDER ---

const sliderDocRef = doc(db, "settings", "heroSlider");
const slideUrl = (photo) => typeof photo === 'string' ? photo : photo.url;

async function getSliderPhotos() {
    const snap = await getDoc(sliderDocRef);
    return snap.exists() ? (snap.data().photos || []) : [];
}

async function loadSliderPreview() {
    try {
        const photos = await getSliderPhotos();
        $('sliderPreview').innerHTML = photos.map((photo, i) => `
            <div class="slide-thumb">
                <img src="${esc(slideUrl(photo))}" alt="">
                ${photo.text ? `<span class="slide-thumb-text">${esc(photo.text)}</span>` : ''}
                <div class="thumb-controls">
                    <button data-slide-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Avancer">‹</button>
                    <button data-slide-edit data-i="${i}" aria-label="Texte et lien">✎</button>
                    <button data-slide-delete data-i="${i}" class="danger" aria-label="Supprimer">×</button>
                    <button data-slide-move="1" data-i="${i}" ${i === photos.length - 1 ? 'disabled' : ''} aria-label="Reculer">›</button>
                </div>
            </div>
        `).join('') || '<p class="empty">Aucune image : le slider est masqué sur l\'accueil.</p>';
    } catch (e) {
        console.error(e);
    }
}

$('sliderPreview').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const i = Number(btn.dataset.i);

    try {
        const photos = await getSliderPhotos();
        if ('slideEdit' in btn.dataset) {
            // Anciennes images stockées en simple URL : "url".link serait String.prototype.link !
            const photo = typeof photos[i] === 'string' ? {} : photos[i];
            $('modalSlideIndex').value = i;
            $('modalSlideLink').value = photo.link || '';
            $('modalSlideText').value = photo.text || '';
            $('sliderModal').showModal();
            return;
        }
        if ('slideDelete' in btn.dataset) {
            if (!confirm("Retirer cette image du slider ?")) return;
            const [removed] = photos.splice(i, 1);
            await updateDoc(sliderDocRef, { photos });
            deleteImages([slideUrl(removed)]);
        } else {
            const j = i + Number(btn.dataset.slideMove);
            [photos[i], photos[j]] = [photos[j], photos[i]];
            await updateDoc(sliderDocRef, { photos });
        }
        loadSliderPreview();
    } catch (error) {
        console.error(error);
        toast("Erreur lors de la mise à jour du slider.", 'error');
    }
});

$('sliderModalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const index = Number($('modalSlideIndex').value);
    try {
        const photos = await getSliderPhotos();
        photos[index] = { url: slideUrl(photos[index]), link: $('modalSlideLink').value.trim(), text: $('modalSlideText').value.trim() };
        await updateDoc(sliderDocRef, { photos });
        $('sliderModal').close();
        loadSliderPreview();
        toast("Image mise à jour");
    } catch (error) {
        console.error(error);
        toast("Erreur lors de l'enregistrement.", 'error');
    }
});

$('sliderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnSubmitSlider');
    const files = $('sliderFiles').files;
    if (files.length === 0) return;

    try {
        btn.disabled = true;
        btn.textContent = "Envoi…";
        const newPhotos = (await uploadImages(files)).map(url => ({ url, text: '', link: '' }));
        const photos = await getSliderPhotos();
        await setDoc(sliderDocRef, { photos: [...photos, ...newPhotos], updatedAt: serverTimestamp() });
        $('sliderForm').reset();
        loadSliderPreview();
        toast("Slider mis à jour");
    } catch (err) {
        toast("Erreur : " + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = "Ajouter au slider";
    }
});

// --- AFFICHAGE : GRILLE "FEATURES" ---

const gridDocRef = doc(db, "settings", "featureGrid");

async function getGrid(type) {
    const snap = await getDoc(gridDocRef);
    return snap.exists() ? (snap.data()[type] || []) : [];
}

async function loadGridPreviews() {
    for (const type of ['boutique', 'conseil']) {
        const urls = await getGrid(type).catch(() => []);
        $(`${type}Preview`).innerHTML = urls.map((url, i) => `
            <div class="grid-thumb">
                <img src="${esc(url)}" alt="">
                <div class="thumb-controls">
                    <button data-type="${type}" data-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Avancer">‹</button>
                    <button data-type="${type}" data-remove data-i="${i}" class="danger" aria-label="Supprimer">×</button>
                    <button data-type="${type}" data-move="1" data-i="${i}" ${i === urls.length - 1 ? 'disabled' : ''} aria-label="Reculer">›</button>
                </div>
            </div>
        `).join('') || '<p class="empty">Aucune image.</p>';
    }
}

async function handleGridClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const { type } = btn.dataset;
    const i = Number(btn.dataset.i);

    try {
        const grid = await getGrid(type);
        if ('remove' in btn.dataset) {
            if (!confirm("Supprimer cette image de la grille ?")) return;
            const [removed] = grid.splice(i, 1);
            await updateDoc(gridDocRef, { [type]: grid });
            deleteImages([removed]);
        } else {
            const j = i + Number(btn.dataset.move);
            [grid[i], grid[j]] = [grid[j], grid[i]];
            await updateDoc(gridDocRef, { [type]: grid });
        }
        loadGridPreviews();
    } catch (error) {
        console.error(error);
        toast("Erreur lors de la mise à jour de la grille.", 'error');
    }
}
$('boutiquePreview').addEventListener('click', handleGridClick);
$('conseilPreview').addEventListener('click', handleGridClick);

async function handleGridUpload(type, form) {
    const files = form.querySelector('input[type="file"]').files;
    if (files.length === 0) return;
    const btn = form.querySelector('button');

    try {
        const grid = await getGrid(type);
        if (grid.length >= 4) return toast("Limite de 4 images atteinte : supprimez-en une d'abord.", 'error');

        btn.disabled = true;
        const [url] = await uploadImages([files[0]]);
        await setDoc(gridDocRef, { [type]: [...grid, url] }, { merge: true });
        form.reset();
        loadGridPreviews();
        toast("Image ajoutée");
    } catch (err) {
        toast("Erreur : " + err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

$('boutiqueGridForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGridUpload('boutique', e.target);
});
$('conseilGridForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGridUpload('conseil', e.target);
});

// --- GUIDES ---

const guideForm = $('guideForm');

async function loadGuides() {
    try {
        const snap = await getDocs(query(collection(db, "guides"), orderBy("createdAt", "desc")));
        guides = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderGuides();
    } catch (error) {
        console.error("Erreur de chargement des guides :", error);
    }
}

function renderGuides() {
    $('guidesList').innerHTML = guides.map(g => `
        <div class="compact-item" data-id="${g.id}">
            ${g.imageUrl ? `<img class="thumb sm" src="${esc(g.imageUrl)}" alt="">` : ''}
            <span class="grow"><strong>${esc(g.title)}</strong><small class="muted">${formatDate(g.createdAt)}</small></span>
            <button class="btn-link" data-guide="edit">Modifier</button>
            <button class="btn-link danger" data-guide="delete">Supprimer</button>
        </div>
    `).join('') || '<p class="empty">Aucune fiche publiée.</p>';
}

function resetGuideForm() {
    editGuideId = null;
    guideForm.reset();
    $('guideFormTitle').textContent = "Rédiger une fiche conseil";
    $('btnSubmitGuide').textContent = "Publier la fiche";
    $('btnCancelGuide').hidden = true;
}

$('btnCancelGuide').addEventListener('click', resetGuideForm);

$('guidesList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-guide]');
    if (!btn) return;
    const g = guides.find(x => x.id === btn.closest('[data-id]').dataset.id);

    if (btn.dataset.guide === 'edit') {
        editGuideId = g.id;
        guideForm.elements['guideTitle'].value = g.title || '';
        guideForm.elements['guideContent'].value = g.content || '';
        $('guideFormTitle').textContent = "Modifier la fiche";
        $('btnSubmitGuide').textContent = "Enregistrer";
        $('btnCancelGuide').hidden = false;
        window.scrollTo(0, 0);
        return;
    }

    if (!confirm(`Supprimer la fiche « ${g.title} » ?`)) return;
    try {
        await deleteDoc(doc(db, "guides", g.id));
        guides = guides.filter(x => x.id !== g.id);
        renderGuides();
        if (editGuideId === g.id) resetGuideForm();
        deleteImages([g.imageUrl]);
        toast("Fiche supprimée");
    } catch (error) {
        console.error(error);
        toast("Erreur lors de la suppression.", 'error');
    }
});

guideForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnSubmitGuide');
    const formData = new FormData(guideForm);
    const files = $('guideFile').files;

    try {
        btn.disabled = true;
        const data = {
            title: formData.get('guideTitle').trim(),
            content: formData.get('guideContent'),
        };
        if (files.length > 0) [data.imageUrl] = await uploadImages([files[0]]);

        if (editGuideId) {
            const g = guides.find(x => x.id === editGuideId);
            const oldImage = data.imageUrl ? g.imageUrl : null;
            await updateDoc(doc(db, "guides", editGuideId), data);
            Object.assign(g, data);
            deleteImages([oldImage]);
            toast("Fiche mise à jour");
        } else {
            data.imageUrl = data.imageUrl || null;
            data.createdAt = serverTimestamp();
            const ref = await addDoc(collection(db, "guides"), data);
            guides.unshift({ id: ref.id, ...data, createdAt: null });
            toast("Fiche conseil publiée");
        }
        resetGuideForm();
        renderGuides();
    } catch (err) {
        console.error("Erreur lors de l'enregistrement de la fiche :", err);
        toast("Erreur : " + err.message, 'error');
    } finally {
        btn.disabled = false;
    }
});
