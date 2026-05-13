import { db } from './firebase-config.js';
import { collection, query, getDocs, orderBy, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let allProducts = []; // Stockage local pour filtrer sans requêter Firebase en boucle

async function loadCatalogue() {
    const productGrid = document.getElementById('productGrid');
    const searchInput = document.getElementById('shopSearch');
    const sortSelect = document.getElementById('shopSort');
    const categoryFilter = document.getElementById('categoryFilter');
    
    const urlParams = new URLSearchParams(window.location.search);
    let initialCat = urlParams.get('cat');

    if (!productGrid) return;

    // Synchronisation du select avec l'URL au chargement
    if (initialCat && categoryFilter) {
        categoryFilter.value = initialCat;
    }

    productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Préparation du vivarium... 🌿</p>';

    try {
        const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        
        const allProducts = querySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const renderProducts = (productsToDisplay) => {
            productGrid.innerHTML = ''; 
            if (productsToDisplay.length === 0) {
                productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Aucun spécimen ne correspond.</p>';
                return;
            }

            productsToDisplay.forEach((product) => {
                const photoUrl = product.photos && product.photos.length > 0 ? product.photos[0] : 'assets/img/placeholder.jpg';
                const card = document.createElement('div');
                card.className = 'product-card';
                card.innerHTML = `
                    <a href="/produit?id=${product.id}" style="text-decoration: none; color: inherit; display: block;">
                        <img src="${photoUrl}" alt="${product.name}" class="product-image">
                        <div class="product-info">
                            <p class="product-latin">${product.latinName}</p>
                            <h3 class="product-name">${product.name}</h3>
                            <p class="product-price">${product.price} €</p>
                        </div>
                    </a>
                    <button class="btn-buy" onclick="addToCart('${product.id}')" ${product.stock <= 0 ? 'disabled' : ''} style="${product.stock <= 0 ? 'background-color: #ccc; cursor: not-allowed;' : ''}">
                        ${product.stock > 0 ? 'AJOUTER AU PANIER' : 'ÉPUISÉ'}
                    </button>
                `;
                productGrid.appendChild(card);
            });
        };

        const filterAndSort = () => {
            let filtered = [...allProducts];
            
            // 1. Filtrage par Catégorie (priorité au select)
            const selectedCat = categoryFilter?.value;
            if (selectedCat && selectedCat !== 'all') {
                filtered = filtered.filter(p => p.category === selectedCat);
            }

            // 2. Recherche par texte
            const searchTerm = searchInput?.value.toLowerCase() || "";
            if (searchTerm) {
                filtered = filtered.filter(p => 
                    p.name.toLowerCase().includes(searchTerm) || 
                    p.latinName.toLowerCase().includes(searchTerm)
                );
            }

            // 3. Tri
            const sortType = sortSelect?.value;
            if (sortType === 'price-asc') filtered.sort((a, b) => a.price - b.price);
            else if (sortType === 'price-desc') filtered.sort((a, b) => b.price - a.price);
            else if (sortType === 'name-asc') filtered.sort((a, b) => a.name.localeCompare(b.name));
            else if (sortType === 'newest') filtered.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

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

window.addToCart = (productId) => {
    console.log("Ajout au panier du produit :", productId);
    // On codera la logique du panier juste après
};

async function loadHeroSlider() {
    const heroHeader = document.querySelector('.hero-slider');
    if (!heroHeader) return; 

    try {
        const docRef = doc(db, "settings", "heroSlider");
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists() && docSnap.data().photos?.length > 0) {
            const photos = docSnap.data().photos;
            let sliderHtml = '';
            
            if (photos.length > 1) {
                sliderHtml += `
                    <div style="position: absolute; top:0; left:0; width:100%; height:100%; z-index: 10; pointer-events: none;">
                        <button class="slider-arrow prev" style="pointer-events: auto;">‹</button>
                        <button class="slider-arrow next" style="pointer-events: auto;">›</button>
                    </div>`;
            }

            photos.forEach((photo, index) => {
                sliderHtml += `<div class="slide" style="background-image: url('${photo}'); position: absolute; top:0; left:0; width: 100%; height: 100%; opacity: ${index === 0 ? 1 : 0}; transition: opacity 1s ease-in-out; background-size: cover; background-position: center; z-index: 1;"></div>`;
            });
            
            heroHeader.innerHTML = sliderHtml;
            
            const slides = heroHeader.querySelectorAll('.slide');
            if (slides.length > 1) {
                let current = 0;
                let sliderInterval;

                const goToSlide = (n) => {
                    slides[current].style.opacity = 0;
                    current = (n + slides.length) % slides.length;
                    slides[current].style.opacity = 1;
                };

                const nextSlide = () => goToSlide(current + 1);
                const prevSlide = () => goToSlide(current - 1);

                heroHeader.querySelector('.next').addEventListener('click', (e) => { 
                    e.preventDefault();
                    nextSlide(); 
                    resetInterval(); 
                });
                heroHeader.querySelector('.prev').addEventListener('click', (e) => { 
                    e.preventDefault();
                    prevSlide(); 
                    resetInterval(); 
                });

                const resetInterval = () => {
                    clearInterval(sliderInterval);
                    sliderInterval = setInterval(nextSlide, 5000);
                };
                
                sliderInterval = setInterval(nextSlide, 5000);
            }
        } else {
            heroHeader.style.display = 'none';
        }
    } catch (error) {
        console.error("Erreur de chargement du slider :", error);
    }
}

// NOUVEAU : Fonction pour charger les détails d'un produit spécifique sur produit.html
async function loadProductDetails() {
    const detailsContainer = document.getElementById('productDetails');
    if (!detailsContainer) return;

    const urlParams = new URLSearchParams(window.location.search);
    const productId = urlParams.get('id');

    if (!productId) {
        detailsContainer.innerHTML = '<p>Produit introuvable.</p>';
        return;
    }

    try {
        const docRef = doc(db, "products", productId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const product = docSnap.data();
            
            // NOUVEAU : Récupération de toutes les photos (ou placeholder par défaut)
            const photos = product.photos && product.photos.length > 0 ? product.photos : ['assets/img/placeholder.jpg'];
            const formattedDescription = product.description.replace(/\n/g, '<br>');

            // NOUVEAU : Construction dynamique du HTML du carrousel avec gestion des flèches si besoin
            let sliderHtml = `<div class="product-slider-container" style="position: relative; overflow: hidden; border-radius: 12px; width: 100%; aspect-ratio: 1/1;">`;
            
            photos.forEach((photo, index) => {
                sliderHtml += `<img src="${photo}" alt="${product.name} - Photo ${index + 1}" class="product-slide" style="width: 100%; height: 100%; object-fit: cover; position: absolute; top: 0; left: 0; opacity: ${index === 0 ? 1 : 0}; transition: opacity 0.8s ease-in-out;">`;
            });

            if (photos.length > 1) {
                sliderHtml += `
                    <button class="slider-arrow prev" style="position: absolute; top: 50%; left: 10px; transform: translateY(-50%); background: rgba(255,255,255,0.7); border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; color: var(--accent-brown); z-index: 10;">‹</button>
                    <button class="slider-arrow next" style="position: absolute; top: 50%; right: 10px; transform: translateY(-50%); background: rgba(255,255,255,0.7); border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; color: var(--accent-brown); z-index: 10;">›</button>
                `;
            }
            sliderHtml += `</div>`;

            detailsContainer.innerHTML = `
                <div class="product-gallery">
                    ${sliderHtml}
                </div>
                
                <div class="product-info-full">
                    <p class="product-latin" style="font-size: 1.2rem;">${product.latinName}</p>
                    <h1 style="font-family: 'Playfair Display', serif; font-size: 2.5rem; margin-top: 5px;">${product.name}</h1>
                    <p class="product-price" style="font-size: 1.5rem;">${product.price} €</p>
                    
                    <div style="margin: 20px 0; padding: 15px; background: #fff; border-radius: 8px; border: 1px solid var(--border-light);">
                        <strong>Difficulté :</strong> <span style="text-transform: capitalize;">${product.difficulty}</span>
                    </div>

                    <div style="margin-bottom: 30px; line-height: 1.6;">
                        ${formattedDescription}
                    </div>

                    <button class="btn-buy" onclick="addToCart('${docSnap.id}')" style="width: 100%; padding: 20px; font-size: 1.2rem;" ${product.stock <= 0 ? 'disabled' : ''}>
                        ${product.stock > 0 ? 'AJOUTER AU PANIER' : 'RUPTURE DE STOCK'}
                    </button>
                    
                    <p style="text-align: center; font-size: 0.8rem; margin-top: 10px; color: #666;">
                        En stock : ${product.stock}
                    </p>
                </div>
            `;

            // NOUVEAU : Logique de défilement (manuel et automatique) pour la galerie
            if (photos.length > 1) {
                let currentSlide = 0;
                const slides = detailsContainer.querySelectorAll('.product-slide');
                const btnPrev = detailsContainer.querySelector('.slider-arrow.prev');
                const btnNext = detailsContainer.querySelector('.slider-arrow.next');
                let slideInterval;

                const goToSlide = (n) => {
                    slides[currentSlide].style.opacity = 0;
                    currentSlide = (n + slides.length) % slides.length;
                    slides[currentSlide].style.opacity = 1;
                };

                const nextSlide = () => goToSlide(currentSlide + 1);
                const prevSlide = () => goToSlide(currentSlide - 1);

                btnNext.addEventListener('click', () => { nextSlide(); resetInterval(); });
                btnPrev.addEventListener('click', () => { prevSlide(); resetInterval(); });

                // Défilement automatique toutes les 5 secondes
                const startInterval = () => {
                    slideInterval = setInterval(nextSlide, 5000); 
                };

                // Réinitialise le chrono si l'utilisateur clique sur une flèche
                const resetInterval = () => {
                    clearInterval(slideInterval);
                    startInterval();
                };

                startInterval();
            }

        } else {
            detailsContainer.innerHTML = '<p>Ce produit n\'existe plus.</p>';
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
        const docRef = doc(db, "settings", "featureGrid");
        const docSnap = await getDoc(docRef);
        
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


// Fonction pour charger la barre de navigation commune
async function loadNavbar() {
    const navElement = document.getElementById('main-navbar');
    if (!navElement) return;

    try {
        const response = await fetch('components/navbar.html');
        const html = await response.text();
        navElement.innerHTML = html;

        // Optionnel : Gérer la classe 'active' selon la page actuelle
        const currentPage = window.location.pathname;
        const links = navElement.querySelectorAll('.nav-links a');
        links.forEach(link => {
            if (link.getAttribute('href') === currentPage || 
               (currentPage === "/" && link.id === "nav-accueil")) {
                link.classList.add('active');
            }
        });
    } catch (error) {
        console.error("Erreur lors du chargement de la navbar :", error);
    }
}

// Ajoute ceci à ton fichier app.js
async function loadFooter() {
    const footerElement = document.getElementById('main-footer');
    if (!footerElement) return;

    try {
        const response = await fetch('components/footer.html');
        const html = await response.text();
        footerElement.innerHTML = html;

        // Gestion de l'envoi du formulaire de contact
        const contactForm = document.getElementById('footer-contact-form');
        if (contactForm) {
            contactForm.addEventListener('submit', (e) => {
                e.preventDefault();
                alert("Merci ! Votre message a bien été envoyé à terra.ophis@gmail.com");
                contactForm.reset();
            });
        }
    } catch (error) {
        console.error("Erreur chargement footer :", error);
    }
}

// On lance les fonctions
loadFooter();
loadFeaturesGrid();
loadHeroSlider();
loadProductDetails();
loadCatalogue();
loadNavbar();