import { auth } from './firebase-config.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const loginForm = document.getElementById('loginForm');
const errorMsg = document.getElementById('authError');

if (new URLSearchParams(window.location.search).get('error') === 'forbidden') {
    errorMsg.textContent = "Ce compte n'a pas accès à l'administration.";
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
        await signInWithEmailAndPassword(auth, email, password);
        // Si ça marche, on est redirigé vers l'admin
        window.location.href = "/admin/admin.html";
    } catch (error) {
        console.error("Erreur de connexion :", error.code);
        errorMsg.textContent = "Email ou mot de passe incorrect.";
    }
});
