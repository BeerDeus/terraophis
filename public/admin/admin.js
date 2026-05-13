import { db, auth } from '../firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, serverTimestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


let editProductId = null;
const productForm = document.getElementById('productForm');
const statusMsg = document.getElementById('uploadStatus');

// --- SÉCURITÉ & AUTHENTIFICATION ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        // L'utilisateur est connecté, on vérifie si c'est le bon email
        if (user.email === "martin.stuis11@gmail.com") {
            console.log("Accès Admin accordé :", user.email);
            loadInventory(); // On lance le chargement des produits
        } else {
            // Connecté mais pas avec le bon compte
            console.warn("Accès refusé pour :", user.email);
            window.location.href = "../login.html?error=forbidden";
        }
    } else {
        // Pas de session trouvée, on attend un tout petit peu ou on redirige
        // Firebase a besoin d'un instant pour vérifier le cache local
        setTimeout(() => {
            if (!auth.currentUser) {
                window.location.href = "../login.html";
            }
        }, 1000); // On laisse 1 seconde de battement
    }
});

// 2. Création de produit
productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmit');
    const formData = new FormData(productForm);
    const files = document.getElementById('productFiles').files;

    try {
        btn.disabled = true;
        // On n'affiche le message d'upload que si de nouveaux fichiers sont détectés
        statusMsg.textContent = files.length > 0 ? "Téléchargement des images vers R2... ⏳" : "Enregistrement en cours...";

        let photoUrls = [];

        // Upload conditionnel (utile en mode édition si on ne change pas les photos)
        if (files.length > 0) {
            const uploadData = new FormData();
            for (let i = 0; i < files.length; i++) { uploadData.append('photos', files[i]); }
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload");
            const { files: uploadedFiles } = await response.json();
            photoUrls = uploadedFiles.map(f => f.url);
        }

        const productData = {
            name: formData.get('name'),
            latinName: formData.get('latinName'),
            price: parseFloat(formData.get('price')),
            stock: parseInt(formData.get('stock')),
            category: formData.get('category'),
            difficulty: formData.get('difficulty'),
            description: formData.get('description'),
        };

        // Branchement de la logique Mise à jour VS Création
        if (editProductId) {
            if (photoUrls.length > 0) {
                productData.photos = photoUrls;
            }
            await updateDoc(doc(db, "products", editProductId), productData);
            statusMsg.textContent = "✅ Produit mis à jour !";
            
            // Réinitialisation de l'état
            editProductId = null;
            btn.textContent = "PUBLIER LE PRODUIT";
            document.getElementById('productFiles').required = true;
        } else {
            if (photoUrls.length === 0) throw new Error("Les photos sont obligatoires.");
            
            productData.photos = photoUrls;
            productData.createdAt = serverTimestamp();
            await addDoc(collection(db, "products"), productData);
            statusMsg.textContent = "✅ Produit ajouté !";
        }

        productForm.reset();
        loadInventory();
    } catch (err) {
        console.error(err);
        statusMsg.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

// 3. Charger l'inventaire pour pouvoir supprimer/gérer
async function loadInventory() {
    const container = document.getElementById('adminInventory');
    container.innerHTML = '<p>Chargement des stocks...</p>';
    
    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    
    container.innerHTML = '';
    snap.forEach(productDoc => {
        const p = productDoc.data();
        const div = document.createElement('div');
        div.className = 'inventory-item';
        div.style.cssText = "display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #ddd; align-items:center;";
        
        // Affichage dynamique pour rupture de stock
        const stockText = p.stock > 0 ? `(${p.stock} en stock)` : `<strong style="color:red;">(Sold Out)</strong>`;
        
        // Ajout de l'appel à la fonction editProduct
        div.innerHTML = `
            <span><strong>${p.name}</strong> ${stockText} - ${p.price}€</span>
            <div>
                <button onclick="editProduct('${productDoc.id}')" style="color:blue; background:none; border:none; cursor:pointer; margin-right:15px;">Modifier</button>
                <button onclick="deleteProduct('${productDoc.id}')" style="color:red; background:none; border:none; cursor:pointer;">Supprimer</button>
            </div>
        `;
        container.appendChild(div);
    });
}

window.editProduct = async (id) => {
    try {
        const docRef = doc(db, "products", id);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const p = docSnap.data();
            
            // Pré-remplissage des champs
            productForm.elements['name'].value = p.name;
            productForm.elements['latinName'].value = p.latinName;
            productForm.elements['price'].value = p.price;
            productForm.elements['stock'].value = p.stock;
            productForm.elements['category'].value = p.category;
            productForm.elements['difficulty'].value = p.difficulty;
            productForm.elements['description'].value = p.description;
            
            // Passage de l'interface en mode édition
            editProductId = id;
            document.getElementById('btnSubmit').textContent = "METTRE À JOUR LE PRODUIT";
            document.getElementById('productFiles').required = false; 
            
            window.scrollTo(0, 0);
        }
    } catch (error) {
        console.error("Erreur de chargement :", error);
        alert("Impossible de charger le produit.");
    }
};

window.deleteProduct = async (id) => {
    if(confirm("Supprimer ce produit du catalogue ?")) {
        await deleteDoc(doc(db, "products", id));
        loadInventory();
    }
};

document.getElementById('btnLogout').addEventListener('click', () => signOut(auth));