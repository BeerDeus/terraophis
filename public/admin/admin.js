import { db, auth } from '../firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, serverTimestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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
            loadInventory(); 
            // NOUVEAU : Chargement des commandes à la connexion
            loadOrders();
            loadSliderPreview();
            loadGridPreviews();
        } else {
            // Connecté mais pas avec le bon compte
            console.warn("Accès refusé pour :", user.email);
            // NOUVEAU : Redirection vers l'URL propre
            window.location.href = "/login?error=forbidden";
        }
    } else {
        // Pas de session trouvée, on attend un tout petit peu ou on redirige
        // Firebase a besoin d'un instant pour vérifier le cache local
        setTimeout(() => {
            if (!auth.currentUser) {
                // NOUVEAU : Redirection vers l'URL propre
                window.location.href = "/login";
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
    if(confirm("Êtes-vous sûr de vouloir supprimer définitivement cet insecte et ses photos ?")) {
        try {
            // NOUVEAU : Récupération du document pour cibler les photos à supprimer
            const docRef = doc(db, "products", id);
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                const product = docSnap.data();
                
                // NOUVEAU : Extraction des clés R2 et appel de l'API de suppression
                if (product.photos && product.photos.length > 0) {
                    const keys = product.photos.map(url => {
                        return new URL(url).pathname.substring(1); 
                    });
                    
                    const token = await auth.currentUser.getIdToken();
                    await fetch('/api/delete', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}` 
                        },
                        body: JSON.stringify({ keys })
                    });
                }
            }
            
            // NOUVEAU : Suppression finale du document Firestore
            await deleteDoc(docRef);
            loadInventory();
            
        } catch (error) {
            console.error("Erreur lors de la suppression :", error);
            alert("Une erreur est survenue lors de la suppression du produit.");
        }
    }
};

// NOUVEAU : Fonction pour récupérer et afficher les commandes
async function loadOrders() {
    const container = document.getElementById('adminOrders');
    container.innerHTML = '<p>Chargement des commandes...</p>';
    
    // On récupère les commandes de la plus récente à la plus ancienne
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    
    container.innerHTML = '';
    
    if (snap.empty) {
        container.innerHTML = '<p>Aucune commande pour le moment.</p>';
        return;
    }

    snap.forEach(orderDoc => {
        const order = orderDoc.data();
        const div = document.createElement('div');
        div.className = 'inventory-item';
        div.style.cssText = "display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #ddd; align-items:center;";
        
        div.innerHTML = `
            <div>
                <strong>Client:</strong> ${order.customerEmail || 'Anonyme'} <br>
                <span style="font-size: 0.8rem; color: #666;">Total: ${order.amountPaid || order.amountValue || 0}€ | Statut actuel: <strong>${order.status || 'Payé'}</strong></span>
            </div>
            <select onchange="updateOrderStatus('${orderDoc.id}', this.value)" style="padding: 5px; font-size: 0.8rem;">
                <option value="Payé" ${order.status === 'Payé' ? 'selected' : ''}>Payé (À préparer)</option>
                <option value="En préparation" ${order.status === 'En préparation' ? 'selected' : ''}>En préparation</option>
                <option value="Expédié" ${order.status === 'Expédié' ? 'selected' : ''}>Expédié</option>
            </select>
        `;
        container.appendChild(div);
    });
}

// NOUVEAU : Fonction pour mettre à jour le statut en base de données
window.updateOrderStatus = async (id, newStatus) => {
    try {
        await updateDoc(doc(db, "orders", id), { status: newStatus });
        // Optionnel : Tu pourras ajouter ici l'envoi d'un email automatique au client pour le prévenir de l'expédition
    } catch (error) {
        console.error("Erreur mise à jour statut :", error);
        alert("Erreur lors de la mise à jour du statut.");
    }
};

document.getElementById('btnLogout').addEventListener('click', () => signOut(auth));

// NOUVEAU: Gestion du système d'onglets
window.switchTab = (tabId, btnElement) => {
    // Masquer tous les contenus
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    // Réinitialiser le style des boutons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--accent-brown)';
    });
    
    // Afficher le bon onglet et styliser le bouton actif
    document.getElementById(tabId).style.display = 'block';
    btnElement.style.background = 'var(--accent-brown)';
    btnElement.style.color = 'white';
};

// NOUVEAU: Upload et sauvegarde des images du Hero Slider
const sliderForm = document.getElementById('sliderForm');
const sliderStatusMsg = document.getElementById('sliderUploadStatus');

if(sliderForm) {
    sliderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitSlider');
    const files = document.getElementById('sliderFiles').files;
    if (files.length === 0) return;
    
    try {
        btn.disabled = true;
        sliderStatusMsg.textContent = "Ajout des images... ⏳";
        
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
        const newUrls = uploadedFiles.map(f => f.url);

        // RÉCUPÉRATION ET FUSION
        const docRef = doc(db, "settings", "heroSlider");
        const docSnap = await getDoc(docRef);
        let finalPhotos = newUrls;

        if (docSnap.exists() && docSnap.data().photos) {
            // On concatène les nouvelles photos aux anciennes au lieu de les remplacer
            const existingPhotos = docSnap.data().photos;
            finalPhotos = [...existingPhotos, ...newUrls];
        }

        await setDoc(docRef, {
            photos: finalPhotos,
            updatedAt: serverTimestamp()
        });

        sliderStatusMsg.textContent = "✅ Images ajoutées avec succès !";
        sliderForm.reset();
        loadSliderPreview(); // On rafraîchit l'aperçu immédiatement
    } catch (err) {
        console.error("Erreur Slider :", err);
        sliderStatusMsg.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});
}

const guideForm = document.getElementById('guideForm');
const guideStatusMsg = document.getElementById('guideUploadStatus');

// Logique de création pour les fiches conseils
guideForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitGuide');
    const formData = new FormData(guideForm);
    const fileInput = document.getElementById('guideFile');
    
    try {
        btn.disabled = true;
        guideStatusMsg.textContent = "Enregistrement de la fiche... ⏳";
        let imageUrl = null;

        // Si une image est sélectionnée, on l'envoie sur R2 via ton API d'upload existante
        if (fileInput.files.length > 0) {
            guideStatusMsg.textContent = "Téléchargement de l'image... ⏳";
            const uploadData = new FormData();
            
            // On utilise la clé 'photos' attendue par ton middleware multer côté serveur
            uploadData.append('photos', fileInput.files[0]); 
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload de l'image");
            
            const { files: uploadedFiles } = await response.json();
            if (uploadedFiles && uploadedFiles.length > 0) {
                imageUrl = uploadedFiles[0].url;
            }
        }

        // Création du document dans la nouvelle collection 'guides'
        guideStatusMsg.textContent = "Création de la fiche...";
        await addDoc(collection(db, "guides"), {
            title: formData.get('guideTitle'),
            content: formData.get('guideContent'),
            imageUrl: imageUrl,
            createdAt: serverTimestamp()
        });

        guideStatusMsg.textContent = "✅ Fiche conseil publiée avec succès !";
        guideForm.reset();
        
    } catch (err) {
        console.error("Erreur lors de la création de la fiche :", err);
        guideStatusMsg.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

async function loadSliderPreview() {
    const preview = document.getElementById('sliderPreview');
    if (!preview) return;

    try {
        const docSnap = await getDoc(doc(db, "settings", "heroSlider"));
        if (docSnap.exists() && docSnap.data().photos?.length > 0) {
            const photos = docSnap.data().photos;
            preview.innerHTML = '';
            photos.forEach((url, index) => {
                const div = document.createElement('div');
                div.className = 'preview-item';
                div.innerHTML = `
                    <img src="${url}">
                    <div class="preview-controls">
                        <button onclick="moveSlider(${index}, -1)" class="btn-outline" ${index === 0 ? 'disabled' : ''}>←</button>
                        <button onclick="deleteSliderImg(${index})" class="btn-delete-img">×</button>
                        <button onclick="moveSlider(${index}, 1)" class="btn-outline" ${index === photos.length - 1 ? 'disabled' : ''}>→</button>
                    </div>
                `;
                preview.appendChild(div);
            });
        } else {
            preview.innerHTML = '<p>Aucun visuel configuré.</p>';
        }
    } catch (e) { console.error(e); }
}

window.deleteSliderImg = async (index) => {
    if (!confirm("Supprimer cette image ?")) return;
    const docRef = doc(db, "settings", "heroSlider");
    const docSnap = await getDoc(docRef);
    const photos = docSnap.data().photos;
    photos.splice(index, 1);
    await updateDoc(docRef, { photos });
    loadSliderPreview();
};

window.moveSlider = async (index, direction) => {
    const docRef = doc(db, "settings", "heroSlider");
    const docSnap = await getDoc(docRef);
    const photos = [...docSnap.data().photos];
    const newIndex = index + direction;
    [photos[index], photos[newIndex]] = [photos[newIndex], photos[index]];
    await updateDoc(docRef, { photos });
    loadSliderPreview();
};

/**
 * Gère l'upload et l'ajout (push) de nouvelles images au slider existant
 */
if(sliderForm) {
    sliderForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btnSubmitSlider');
        const files = document.getElementById('sliderFiles').files;
        if (files.length === 0) return;
        
        try {
            btn.disabled = true;
            sliderStatusMsg.textContent = "Upload des nouvelles images... ⏳";
            
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
            const newUrls = uploadedFiles.map(f => f.url);

            // On récupère les anciennes photos pour ajouter les nouvelles à la suite
            const docRef = doc(db, "settings", "heroSlider");
            const docSnap = await getDoc(docRef);
            let finalPhotos = newUrls;

            if (docSnap.exists() && docSnap.data().photos) {
                finalPhotos = [...docSnap.data().photos, ...newUrls];
            }

            await setDoc(docRef, {
                photos: finalPhotos,
                updatedAt: serverTimestamp()
            });

            sliderStatusMsg.textContent = "✅ Slider mis à jour !";
            sliderForm.reset();
            loadSliderPreview();
        } catch (err) {
            sliderStatusMsg.textContent = "❌ Erreur : " + err.message;
        } finally {
            btn.disabled = false;
        }
    });
}

async function handleGridUpload(type, files, statusId, previewId) {
    const status = document.getElementById(statusId);
    if (files.length !== 4) {
        status.textContent = "❌ Veuillez sélectionner exactement 4 images.";
        return;
    }

    try {
        status.textContent = "Upload des 4 images... ⏳";
        const uploadData = new FormData();
        for (let i = 0; i < 4; i++) { uploadData.append('photos', files[i]); }
        
        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: uploadData
        });

        const { files: uploadedFiles } = await response.json();
        const urls = uploadedFiles.map(f => f.url);

        await setDoc(doc(db, "settings", "featureGrid"), { [type]: urls }, { merge: true });
        
        status.textContent = "✅ Grille mise à jour !";
        loadGridPreviews();
    } catch (err) {
        status.textContent = "❌ Erreur : " + err.message;
    }
}

document.getElementById('boutiqueGridForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGridUpload('boutique', document.getElementById('boutiqueFiles').files, 'uploadStatus', 'boutiquePreview');
});

document.getElementById('conseilGridForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGridUpload('conseil', document.getElementById('conseilFiles').files, 'uploadStatus', 'conseilPreview');
});

async function loadGridPreviews() {
    const docSnap = await getDoc(doc(db, "settings", "featureGrid"));
    if (!docSnap.exists()) return;
    const data = docSnap.data();

    const updatePreview = (id, urls) => {
        const el = document.getElementById(id);
        if (el && urls) {
            el.innerHTML = urls.map(url => `<div class="preview-item"><img src="${url}"></div>`).join('');
        }
    };

    updatePreview('boutiquePreview', data.boutique);
    updatePreview('conseilPreview', data.conseil);
}