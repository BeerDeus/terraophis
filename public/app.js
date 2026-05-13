import { db } from './firebase-config.js';
import { collection, query, getDocs, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

async function loadCatalogue() {
    const productGrid = document.getElementById('productGrid');
    if (!productGrid) return;

    productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Chargement des merveilles... 🌿</p>';

    try {
        const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        
        productGrid.innerHTML = ''; // On vide le message de chargement

        if (querySnapshot.empty) {
            productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">La boutique est vide pour le moment.</p>';
            return;
        }

        querySnapshot.forEach((doc) => {
            const product = doc.data();
            const photoUrl = product.photos && product.photos.length > 0 ? product.photos[0] : 'assets/img/placeholder.jpg';

            const card = document.createElement('div');
            card.className = 'product-card';
            card.innerHTML = `
                <img src="${photoUrl}" alt="${product.name}" class="product-image">
                <div class="product-info">
                    <p class="product-latin">${product.latinName}</p>
                    <h3 class="product-name">${product.name}</h3>
                    <p class="product-price">${product.price} €</p>
                    <button class="btn-buy" onclick="addToCart('${doc.id}')">AJOUTER AU PANIER</button>
                </div>
            `;
            productGrid.appendChild(card);
        });
    } catch (error) {
        console.error("Erreur catalogue :", error);
        productGrid.innerHTML = '<p>Erreur lors du chargement des produits.</p>';
    }
}

window.addToCart = (productId) => {
    console.log("Ajout au panier du produit :", productId);
    // On codera la logique du panier juste après
};

loadCatalogue();