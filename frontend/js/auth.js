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
      if (!data.user.approved) {
        showToast('Sua conta está em análise. Aguarde aprovação para dar lances.', 'warning', 6000);
      }
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
      showToast('Conta criada! Aguarde aprovação do administrador para dar lances.', 'info', 8000);
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
    var statusIcon = currentUser.approved ? 'fa-user-check' : 'fa-user-clock';
    var statusColor = currentUser.approved ? '' : ' style="color:#ffd60a"';
    btn.innerHTML = '<i class="fas ' + statusIcon + '"' + statusColor + '></i> ' + currentUser.name.split(' ')[0] + ' <i class="fas fa-chevron-down" style="font-size:0.6rem;margin-left:4px"></i>';
    btn.onclick = function(e) {
      e.stopPropagation();
      var existing = document.getElementById('user-dropdown');
      if (existing) { existing.remove(); return; }
      var dd = document.createElement('div');
      dd.id = 'user-dropdown';
      dd.style.cssText = 'position:absolute;top:100%;right:0;background:#1a1d2e;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px 0;min-width:160px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.4)';
      dd.innerHTML = '<a onclick="navigateTo(\'dashboard\');document.getElementById(\'user-dropdown\').remove();" style="display:block;padding:10px 16px;color:#fff;text-decoration:none;font-size:0.85rem;cursor:pointer"><i class="fas fa-chart-line" style="margin-right:8px;color:#a29bfe"></i>Meu Painel</a><a onclick="logout();document.getElementById(\'user-dropdown\').remove();" style="display:block;padding:10px 16px;color:#ff7675;text-decoration:none;font-size:0.85rem;cursor:pointer"><i class="fas fa-sign-out-alt" style="margin-right:8px"></i>Sair</a>';
      btn.parentElement.style.position = 'relative';
      btn.parentElement.appendChild(dd);
      document.addEventListener('click', function closeDD() { var el = document.getElementById('user-dropdown'); if(el) el.remove(); document.removeEventListener('click', closeDD); }, { once: true });
    };
  } else {
    btn.innerHTML = '<i class="fas fa-user"></i> Entrar';
    btn.onclick = openModal;
  }
}

function isUserApproved() {
  return currentUser && currentUser.approved;
}

function requireLogin() {
  if (!currentUser) {
    openModal();
    return false;
  }
  if (!currentUser.approved) {
    showToast('Sua conta está em análise. Aguarde aprovação do administrador.', 'warning', 5000);
    return false;
  }
  return true;
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
