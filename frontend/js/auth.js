// Auth module
let currentUser = null;

function openModal() {
  document.getElementById('modal-auth').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-auth').style.display = 'none';
  document.getElementById('login-error').textContent = '';
  document.getElementById('register-error').textContent = '';
}

function switchTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
  if (tab === 'login') {
    document.getElementById('form-login').style.display = 'block';
    document.getElementById('form-register').style.display = 'none';
    document.querySelectorAll('.modal-tab')[0].classList.add('active');
  } else {
    document.getElementById('form-login').style.display = 'none';
    document.getElementById('form-register').style.display = 'block';
    document.querySelectorAll('.modal-tab')[1].classList.add('active');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('lp_token', data.token);
      localStorage.setItem('lp_user', JSON.stringify(data.user));
      currentUser = data.user;
      updateAuthUI();
      closeModal();
    } else {
      document.getElementById('login-error').textContent = data.error;
    }
  } catch (err) {
    document.getElementById('login-error').textContent = 'Erro de conexão';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const phone = document.getElementById('reg-phone').value;
  const cpf = document.getElementById('reg-cpf').value;
  const password = document.getElementById('reg-password').value;

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, cpf, password })
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('lp_token', data.token);
      localStorage.setItem('lp_user', JSON.stringify(data.user));
      currentUser = data.user;
      updateAuthUI();
      closeModal();
    } else {
      document.getElementById('register-error').textContent = data.error;
    }
  } catch (err) {
    document.getElementById('register-error').textContent = 'Erro de conexão';
  }
}

function logout() {
  localStorage.removeItem('lp_token');
  localStorage.removeItem('lp_user');
  currentUser = null;
  updateAuthUI();
}

function updateAuthUI() {
  const btn = document.getElementById('btn-login');
  if (currentUser) {
    btn.innerHTML = `<i class="fas fa-user-check"></i> ${currentUser.name.split(' ')[0]}`;
    btn.onclick = logout;
  } else {
    btn.innerHTML = `<i class="fas fa-user"></i> Entrar`;
    btn.onclick = openModal;
  }
}

// Check saved session
(function checkAuth() {
  const saved = localStorage.getItem('lp_user');
  if (saved) {
    currentUser = JSON.parse(saved);
    updateAuthUI();
  } else {
    document.getElementById('btn-login').onclick = openModal;
  }
})();
