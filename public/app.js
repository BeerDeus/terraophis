import { db } from './firebase-config.js';
import { collection, query, getDocs, orderBy, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const PLACEHOLDER_IMG = '/assets/img/logo_carre.png';

// Échappe le texte avant de l'injecter dans du HTML
const esc = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatPrice = (n) => Number(n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const isOnSale = (p) => Number(p.compareAtPrice) > Number(p.price);
const priceHtml = (p) => isOnSale(p)
    ? `<s class="price-old">${formatPrice(p.compareAtPrice)}</s> <span class="price-sale">${formatPrice(p.price)}</span>`
    : formatPrice(p.price);

const getCart = () => JSON.parse(localStorage.getItem('terraophis_cart')) || [];
const saveCart = (cart) => localStorage.setItem('terraophis_cart', JSON.stringify(cart));

async function loadCatalogue() {
    const productGrid = document.getElementById('productGrid');
    const searchInput = document.getElementById('shopSearch');
    const sortSelect = document.getElementById('shopSort');
    const categoryFilter = document.getElementById('categoryFilter');

    if (!productGrid) return;

    // Synchronisation du select avec l'URL au chargement
    const initialCat = new URLSearchParams(window.location.search).get('cat');
    if (initialCat && categoryFilter) {
        categoryFilter.value = initialCat;
    }

    productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Préparation du vivarium... 🌿</p>';

    try {
        const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);

        // Les articles masqués depuis l'admin n'apparaissent pas dans la boutique
        const allProducts = querySnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(p => !p.hidden);

        const renderProducts = (productsToDisplay) => {
            productGrid.innerHTML = '';
            if (productsToDisplay.length === 0) {
                productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Aucun spécimen ne correspond.</p>';
                return;
            }

            productsToDisplay.forEach((product) => {
                const photoUrl = product.photos?.[0] || PLACEHOLDER_IMG;
                const soldOut = !(product.stock > 0);
                const card = document.createElement('div');
                card.className = 'product-card';
                card.innerHTML = `
                    <a href="/produit?id=${product.id}" style="text-decoration: none; color: inherit; display: block; position: relative;">
                        ${isOnSale(product) ? '<span class="product-badge">PROMO</span>' : ''}
                        <img src="${esc(photoUrl)}" alt="${esc(product.name)}" class="product-image" loading="lazy">
                        <div class="product-info">
                            <p class="product-latin">${esc(product.latinName)}</p>
                            <h3 class="product-name">${esc(product.name)}</h3>
                            <p class="product-price">${priceHtml(product)}</p>
                        </div>
                    </a>
                    <button class="btn-buy" onclick="addToCart('${product.id}')" ${soldOut ? 'disabled' : ''}>
                        ${soldOut ? 'ÉPUISÉ' : 'AJOUTER AU PANIER'}
                    </button>
                `;
                productGrid.appendChild(card);
            });
        };

        const filterAndSort = () => {
            let filtered = [...allProducts];

            // 1. Filtrage par Catégorie ("offres" = articles avec un prix barré)
            const selectedCat = categoryFilter?.value;
            if (selectedCat === 'offres') {
                filtered = filtered.filter(isOnSale);
            } else if (selectedCat && selectedCat !== 'all') {
                filtered = filtered.filter(p => p.category === selectedCat);
            }

            // 2. Recherche par texte
            const searchTerm = searchInput?.value.toLowerCase() || "";
            if (searchTerm) {
                filtered = filtered.filter(p =>
                    (p.name || '').toLowerCase().includes(searchTerm) ||
                    (p.latinName || '').toLowerCase().includes(searchTerm)
                );
            }

            // 3. Tri
            const sortType = sortSelect?.value;
            if (sortType === 'price-asc') filtered.sort((a, b) => a.price - b.price);
            else if (sortType === 'price-desc') filtered.sort((a, b) => b.price - a.price);
            else if (sortType === 'name-asc') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            renderProducts(filtered);
        };

        searchInput?.addEventListener('input', filterAndSort);
        sortSelect?.addEventListener('change', filterAndSort);
        categoryFilter?.addEventListener('change', filterAndSort);

        filterAndSort();

    } catch (error) {
        console.error("Erreur catalogue :", error);
        productGrid.innerHTML = '<p>Erreur lors du chargement des produits.</p>';
    }
}

window.addToCart = async (productId) => {
    // On vérifie le stock réel en direct sur Firestore
    const docSnap = await getDoc(doc(db, "products", productId));
    if (!docSnap.exists() || docSnap.data().hidden) return;
    const maxStock = docSnap.data().stock;

    const cart = getCart();
    const existingItem = cart.find(item => item.id === productId);

    if (existingItem) {
        if (existingItem.quantity >= maxStock) {
            alert("Stock maximum atteint pour ce spécimen 🌿");
            return;
        }
        existingItem.quantity += 1;
    } else {
        if (!(maxStock > 0)) return; // Sécurité anti-rupture
        cart.push({ id: productId, quantity: 1 });
    }

    saveCart(cart);
    toggleCart(true);
};

window.renderCart = async () => {
    const container = document.getElementById('cartItemsContainer');
    const totalEl = document.getElementById('cartTotalAmount');
    const btnCheckout = document.getElementById('btnCheckout');
    let cart = getCart();

    if (cart.length === 0) {
        container.innerHTML = '<p style="text-align: center; margin-top: 50px; color: #888;">Votre panier est vide.</p>';
        totalEl.textContent = formatPrice(0);
        btnCheckout.disabled = true;
        btnCheckout.style.opacity = '0.5';
        return;
    }

    container.innerHTML = '<p style="text-align: center;">Chargement de vos spécimens...</p>';

    const snaps = await Promise.all(cart.map(item => getDoc(doc(db, "products", item.id)).catch(() => null)));
    let total = 0;
    let html = '';

    cart = cart.filter((item, i) => {
        const snap = snaps[i];
        if (!snap?.exists() || snap.data().hidden) return false; // Article supprimé ou masqué
        const p = snap.data();

        // Ajustement automatique si le stock a baissé sur le site
        item.quantity = Math.min(item.quantity, p.stock || 0);
        if (item.quantity <= 0) return false;

        total += p.price * item.quantity;
        const photo = p.photos?.[0] || PLACEHOLDER_IMG;
        html += `
            <div class="cart-item" style="position: relative;">
                <img src="${esc(photo)}" alt="${esc(p.name)}">
                <div class="cart-item-details">
                    <button onclick="removeFromCart('${item.id}')" aria-label="Retirer" style="position: absolute; top: 10px; right: 10px; background: none; border: none; color: #a35d5d; font-size: 1.5rem; cursor: pointer; line-height: 1;">&times;</button>
                    <p class="cart-item-title" style="padding-right: 20px;">${esc(p.name)}</p>
                    <p class="cart-item-price">${formatPrice(p.price)}</p>
                    <div class="cart-qty-controls">
                        <button onclick="updateCartQty('${item.id}', -1, ${p.stock})">-</button>
                        <span>${item.quantity}</span>
                        <button onclick="updateCartQty('${item.id}', 1, ${p.stock})">+</button>
                    </div>
                </div>
            </div>
        `;
        return true;
    });
    saveCart(cart);

    container.innerHTML = html || '<p style="text-align: center; margin-top: 50px; color: #888;">Les articles de votre panier ne sont plus disponibles.</p>';
    totalEl.textContent = formatPrice(total);
    btnCheckout.disabled = cart.length === 0;
    btnCheckout.style.opacity = cart.length === 0 ? '0.5' : '1';
};

// Transmission du maxStock pour bloquer l'incrémentation dans le panier
window.updateCartQty = (productId, change, maxStock) => {
    const cart = getCart();
    const itemIndex = cart.findIndex(item => item.id === productId);

    if (itemIndex > -1) {
        const newQty = cart[itemIndex].quantity + change;

        if (change > 0 && newQty > maxStock) {
            alert("Stock maximum atteint pour ce spécimen 🌿");
            return;
        }

        cart[itemIndex].quantity = newQty;
        if (cart[itemIndex].quantity <= 0) {
            cart.splice(itemIndex, 1);
        }
        saveCart(cart);
        renderCart();
    }
};

window.removeFromCart = (productId) => {
    saveCart(getCart().filter(item => item.id !== productId));
    renderCart();
};

window.toggleCart = (forceOpen = false) => {
    const overlay = document.getElementById('cartOverlay');
    const sidebar = document.getElementById('cartSidebar');
    if (!sidebar) return;

    if (forceOpen || !sidebar.classList.contains('open')) {
        overlay.classList.add('active');
        sidebar.classList.add('open');
        renderCart();
    } else {
        overlay.classList.remove('active');
        sidebar.classList.remove('open');
    }
};

window.processCheckout = async () => {
    const btn = document.getElementById('btnCheckout');
    const cart = getCart();
    if (cart.length === 0) return;

    try {
        btn.disabled = true;
        btn.textContent = 'PRÉPARATION... ⏳';

        // Le serveur recalcule les prix et crée la commande : le client n'envoie que les ids/quantités
        const response = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: cart.map(({ id, quantity }) => ({ id, quantity })) })
        });

        const data = await response.json();
        if (!data.url) throw new Error(data.error || "Erreur de connexion à Stripe");

        // Redirection vers la page de paiement sécurisée Stripe
        window.location.href = data.url;
    } catch (error) {
        console.error("Erreur Checkout :", error);
        alert(error.message || "Une erreur est survenue lors de la création de la commande.");
        btn.disabled = false;
        btn.textContent = 'VALIDER LA COMMANDE';
        renderCart();
    }
};

async function loadHeroSlider() {
    const heroHeader = document.querySelector('.hero-slider');
    if (!heroHeader) return;

    try {
        const docSnap = await getDoc(doc(db, "settings", "heroSlider"));

        if (docSnap.exists() && docSnap.data().photos?.length > 0) {
            const photos = docSnap.data().photos;
            let sliderHtml = '';

            if (photos.length > 1) {
                sliderHtml += `
                    <div style="position: absolute; top:0; left:0; width:100%; height:100%; z-index: 10; pointer-events: none;">
                        <button class="slider-arrow prev" style="pointer-events: auto;" aria-label="Précédent">‹</button>
                        <button class="slider-arrow next" style="pointer-events: auto;" aria-label="Suivant">›</button>
                    </div>`;
            }

            photos.forEach((photoData, index) => {
                const isObject = typeof photoData === 'object' && photoData !== null;
                const url = isObject ? photoData.url : photoData;
                const text = isObject ? (photoData.text || '') : '';
                const link = isObject ? (photoData.link || '').trim() : '';

                const bannerHtml = text ? `<div class="slide-banner">${esc(text)}</div>` : '';
                const tag = link ? 'a' : 'div';
                const hrefAttr = link ? `href="${esc(link)}"` : '';

                // pointer-events (auto/none) pour éviter que les slides cachées bloquent le clic
                sliderHtml += `
                    <${tag} ${hrefAttr} class="slide" style="display: block; text-decoration: none; background-image: url('${esc(url)}'); position: absolute; top:0; left:0; width: 100%; height: 100%; opacity: ${index === 0 ? 1 : 0}; pointer-events: ${index === 0 ? 'auto' : 'none'}; transition: opacity 1s ease-in-out; background-size: cover; background-position: center; z-index: 1;">
                        ${bannerHtml}
                    </${tag}>
                `;
            });

            heroHeader.innerHTML = sliderHtml;

            const slides = heroHeader.querySelectorAll('.slide');
            if (slides.length > 1) {
                let current = 0;
                let sliderInterval;

                const goToSlide = (n) => {
                    slides[current].style.opacity = 0;
                    slides[current].style.pointerEvents = 'none';
                    current = (n + slides.length) % slides.length;
                    slides[current].style.opacity = 1;
                    slides[current].style.pointerEvents = 'auto';
                };

                const nextSlide = () => goToSlide(current + 1);
                const resetInterval = () => {
                    clearInterval(sliderInterval);
                    sliderInterval = setInterval(nextSlide, 5000);
                };

                heroHeader.querySelector('.next').addEventListener('click', (e) => {
                    e.preventDefault();
                    nextSlide();
                    resetInterval();
                });
                heroHeader.querySelector('.prev').addEventListener('click', (e) => {
                    e.preventDefault();
                    goToSlide(current - 1);
                    resetInterval();
                });

                resetInterval();
            }
        } else {
            heroHeader.style.display = 'none';
        }
    } catch (error) {
        console.error("Erreur de chargement du slider :", error);
    }
}

// Charge les détails d'un produit spécifique sur produit.html
async function loadProductDetails() {
    const detailsContainer = document.getElementById('productDetails');
    if (!detailsContainer) return;

    const productId = new URLSearchParams(window.location.search).get('id');
    if (!productId) {
        detailsContainer.innerHTML = '<p>Produit introuvable.</p>';
        return;
    }

    try {
        const docSnap = await getDoc(doc(db, "products", productId));

        if (!docSnap.exists() || docSnap.data().hidden) {
            detailsContainer.innerHTML = '<p>Ce produit n\'est plus disponible. <a href="/boutique">Voir la boutique</a></p>';
            return;
        }

        const product = docSnap.data();
        document.title = `${product.name} | Terraophis`;

        const photos = product.photos?.length > 0 ? product.photos : [PLACEHOLDER_IMG];
        const formattedDescription = esc(product.description).replace(/\n/g, '<br>');
        const difficultyLabels = { debutant: 'Débutant', intermediaire: 'Intermédiaire', expert: 'Expert' };
        const inStock = product.stock > 0;

        // Carrousel avec flèches si plusieurs photos
        let sliderHtml = `<div class="product-slider-container" style="position: relative; overflow: hidden; border-radius: 12px; width: 100%; aspect-ratio: 1/1;">`;
        photos.forEach((photo, index) => {
            sliderHtml += `<img src="${esc(photo)}" alt="${esc(product.name)} - Photo ${index + 1}" class="product-slide" style="width: 100%; height: 100%; object-fit: cover; position: absolute; top: 0; left: 0; opacity: ${index === 0 ? 1 : 0}; transition: opacity 0.8s ease-in-out;">`;
        });
        if (photos.length > 1) {
            sliderHtml += `
                <button class="slider-arrow prev" aria-label="Photo précédente" style="position: absolute; top: 50%; left: 10px; transform: translateY(-50%); background: rgba(255,255,255,0.7); border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; color: var(--accent-brown); z-index: 10;">‹</button>
                <button class="slider-arrow next" aria-label="Photo suivante" style="position: absolute; top: 50%; right: 10px; transform: translateY(-50%); background: rgba(255,255,255,0.7); border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; color: var(--accent-brown); z-index: 10;">›</button>
            `;
        }
        sliderHtml += `</div>`;

        detailsContainer.innerHTML = `
            <div class="product-gallery">
                ${sliderHtml}
            </div>

            <div class="product-info-full">
                <p class="product-latin" style="font-size: 1.2rem;">${esc(product.latinName)}</p>
                <h1 style="font-family: 'Playfair Display', serif; font-size: 2.5rem; margin-top: 5px;">${esc(product.name)}</h1>
                <p class="product-price" style="font-size: 1.5rem;">${priceHtml(product)}</p>

                ${difficultyLabels[product.difficulty] ? `
                <div style="margin: 20px 0; padding: 15px; background: #fff; border-radius: 8px; border: 1px solid var(--border-light);">
                    <strong>Difficulté :</strong> ${difficultyLabels[product.difficulty]}
                </div>` : ''}

                <div style="margin-bottom: 30px; line-height: 1.6;">
                    ${formattedDescription}
                </div>

                <button class="btn-buy" onclick="addToCart('${docSnap.id}')" style="width: 100%; padding: 20px; font-size: 1.2rem;" ${inStock ? '' : 'disabled'}>
                    ${inStock ? 'AJOUTER AU PANIER' : 'RUPTURE DE STOCK'}
                </button>

                <p style="text-align: center; font-size: 0.8rem; margin-top: 10px; color: #666;">
                    ${!inStock ? 'Bientôt de retour' : product.stock <= 3 ? `Plus que ${product.stock} en stock !` : `En stock : ${product.stock}`}
                </p>
            </div>
        `;

        // Défilement manuel et automatique de la galerie
        if (photos.length > 1) {
            let currentSlide = 0;
            let slideInterval;
            const slides = detailsContainer.querySelectorAll('.product-slide');

            const goToSlide = (n) => {
                slides[currentSlide].style.opacity = 0;
                currentSlide = (n + slides.length) % slides.length;
                slides[currentSlide].style.opacity = 1;
            };
            const resetInterval = () => {
                clearInterval(slideInterval);
                slideInterval = setInterval(() => goToSlide(currentSlide + 1), 5000);
            };

            detailsContainer.querySelector('.slider-arrow.next').addEventListener('click', () => { goToSlide(currentSlide + 1); resetInterval(); });
            detailsContainer.querySelector('.slider-arrow.prev').addEventListener('click', () => { goToSlide(currentSlide - 1); resetInterval(); });
            resetInterval();
        }
    } catch (error) {
        console.error("Erreur détails produit :", error);
        detailsContainer.innerHTML = '<p>Erreur lors du chargement.</p>';
    }
}

/**
 * Récupère les configurations de la grille "Features" et les applique
 */
async function loadFeaturesGrid() {
    const boutiqueCard = document.getElementById('boutique-feature');
    const conseilCard = document.getElementById('conseil-feature');
    if (!boutiqueCard || !conseilCard) return;

    try {
        const docSnap = await getDoc(doc(db, "settings", "featureGrid"));

        if (docSnap.exists()) {
            const data = docSnap.data();

            const applyImages = (container, urls) => {
                if (!urls) return;
                const imgs = container.querySelectorAll('img');
                urls.forEach((url, i) => {
                    if (imgs[i]) imgs[i].src = url;
                });
            };

            applyImages(boutiqueCard, data.boutique);
            applyImages(conseilCard, data.conseil);
        }
    } catch (e) {
        console.error("Erreur de chargement de la grille :", e);
    }
}

// Fiches conseils publiées depuis l'admin (section #conseils de l'accueil)
async function loadGuides() {
    const list = document.getElementById('guidesList');
    if (!list) return;

    try {
        const snap = await getDocs(query(collection(db, "guides"), orderBy("createdAt", "desc")));
        if (snap.empty) {
            list.closest('section').style.display = 'none';
            return;
        }

        list.innerHTML = snap.docs.map(d => {
            const g = d.data();
            return `
                <details class="guide-card">
                    <summary>
                        ${g.imageUrl ? `<img src="${esc(g.imageUrl)}" alt="" loading="lazy">` : ''}
                        <h3>${esc(g.title)}</h3>
                        <span class="guide-more">Lire la fiche</span>
                    </summary>
                    <div class="guide-content">${esc(g.content).replace(/\n/g, '<br>')}</div>
                </details>
            `;
        }).join('');
    } catch (e) {
        console.error("Erreur de chargement des guides :", e);
    }
}

async function loadNavbar() {
    const navElement = document.getElementById('main-navbar');
    if (!navElement) return;

    try {
        const response = await fetch('/components/navbar.html');
        navElement.innerHTML = await response.text();

        const currentPage = window.location.pathname;
        navElement.querySelectorAll('.nav-links a').forEach(link => {
            if (link.getAttribute('href') === currentPage ||
               (currentPage === "/" && link.id === "nav-accueil")) {
                link.classList.add('active');
            }
        });

        const hamburgerBtn = navElement.querySelector('#hamburger-btn');
        const navLinks = navElement.querySelector('#nav-links');

        if (hamburgerBtn && navLinks) {
            hamburgerBtn.addEventListener('click', () => {
                navLinks.classList.toggle('open');
                hamburgerBtn.classList.toggle('active');
            });
            // Ferme le menu mobile quand on suit un lien (utile pour les ancres #conseils)
            navLinks.addEventListener('click', (e) => {
                if (e.target.closest('a')) {
                    navLinks.classList.remove('open');
                    hamburgerBtn.classList.remove('active');
                }
            });
        }
    } catch (error) {
        console.error("Erreur lors du chargement de la navbar :", error);
    }
}

async function loadFooter() {
    const footerElement = document.getElementById('main-footer');
    if (!footerElement) return;

    try {
        const response = await fetch('/components/footer.html');
        footerElement.innerHTML = await response.text();

        // Envoi réel du formulaire de contact
        const contactForm = document.getElementById('footer-contact-form');
        contactForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = contactForm.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.textContent = 'ENVOI...';

            try {
                const res = await fetch('/api/contact', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.fromEntries(new FormData(contactForm)))
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                alert("Merci ! Votre message a bien été envoyé. Nous vous répondrons rapidement 🌿");
                contactForm.reset();
            } catch (err) {
                alert(err.message || "L'envoi a échoué. Écrivez-nous directement à terra.ophis@gmail.com.");
            } finally {
                btn.disabled = false;
                btn.textContent = 'ENVOYER LE MESSAGE';
            }
        });
    } catch (error) {
        console.error("Erreur chargement footer :", error);
    }
}

// On lance les fonctions
loadNavbar();
loadFooter();
loadFeaturesGrid();
loadHeroSlider();
loadGuides();
loadProductDetails();
loadCatalogue();
