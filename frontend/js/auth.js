// Auth module
let currentUser = null;

function openModal() {
  var menu = document.querySelector('.nav-menu');
  if (menu) menu.classList.remove('open');
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

// Mascara CPF em tempo real: aceita SO numero (qualquer letra/caracter e
// descartado) e formata 000.000.000-00 conforme digita. inputmode="numeric"
// no HTML ja garante o teclado numerico no celular.
function maskCpfInput(input) {
  var v = (input.value || '').replace(/\D/g, '').slice(0, 11);
  var out = v;
  if (v.length > 9) out = v.slice(0, 3) + '.' + v.slice(3, 6) + '.' + v.slice(6, 9) + '-' + v.slice(9);
  else if (v.length > 6) out = v.slice(0, 3) + '.' + v.slice(3, 6) + '.' + v.slice(6);
  else if (v.length > 3) out = v.slice(0, 3) + '.' + v.slice(3);
  input.value = out;
}

// Mascara telefone BR: (XX) XXXXX-XXXX (celular) ou (XX) XXXX-XXXX (fixo).
function maskPhoneInput(input) {
  var v = (input.value || '').replace(/\D/g, '').slice(0, 11);
  var out = v;
  if (v.length > 10) out = '(' + v.slice(0, 2) + ') ' + v.slice(2, 7) + '-' + v.slice(7);
  else if (v.length > 6) out = '(' + v.slice(0, 2) + ') ' + v.slice(2, 6) + '-' + v.slice(6);
  else if (v.length > 2) out = '(' + v.slice(0, 2) + ') ' + v.slice(2);
  else if (v.length > 0) out = '(' + v;
  input.value = out;
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const phone = document.getElementById('reg-phone').value;
  const cpf = document.getElementById('reg-cpf').value;
  const password = document.getElementById('reg-password').value;
  const termsChecked = document.getElementById('reg-terms').checked;
  if (!termsChecked) {
    document.getElementById('register-error').textContent = 'Você precisa aceitar os Termos de Uso.';
    return;
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, cpf, password, terms_accepted: true, terms_version: '2026.2' })
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

// Token expirou no servidor: limpa sessão local e avisa o usuário.
function handleSessionExpired() {
  if (!localStorage.getItem('lp_token')) return; // já deslogado
  localStorage.removeItem('lp_token');
  localStorage.removeItem('lp_user');
  currentUser = null;
  updateAuthUI();
  if (typeof showToast === 'function') {
    showToast('Sua sessão expirou. Faça login novamente.', 'warning', 6000);
  }
  if (typeof openModal === 'function') {
    setTimeout(openModal, 400);
  }
}

function updateAuthUI() {
  const btn = document.getElementById('btn-login');
  if (currentUser) {
    var statusIcon = currentUser.approved ? 'fa-user-check' : 'fa-user-clock';
    var statusColor = currentUser.approved ? '' : ' style="color:#ffd60a"';
    btn.innerHTML = '<i class="fas ' + statusIcon + '"' + statusColor + '></i> ' + currentUser.name.split(' ')[0] + ' <i class="fas fa-chevron-down" style="font-size:0.6rem;margin-left:4px"></i>';
    btn.onclick = function(e) {
      e.stopPropagation();
      var nav = document.querySelector('.nav-menu');
      if (nav) nav.classList.remove('open');
      navigateTo('profile'); // vai direto pra aba Minha Conta (logout fica lá dentro)
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
  const token = localStorage.getItem('lp_token');
  if (saved) {
    currentUser = JSON.parse(saved);
    updateAuthUI();
  } else {
    document.getElementById('btn-login').onclick = openModal;
  }
  // Valida o token no servidor: se expirou ou está inválido,
  // limpa a sessão pra evitar erro "Token inválido" na hora do lance.
  if (token) {
    fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) {
        if (r.status === 401 || r.status === 403) {
          localStorage.removeItem('lp_token');
          localStorage.removeItem('lp_user');
          currentUser = null;
          updateAuthUI();
        } else if (r.ok) {
          return r.json().then(function(data) {
            if (data && data.success && data.user) {
              localStorage.setItem('lp_user', JSON.stringify(data.user));
              currentUser = data.user;
              updateAuthUI();
            }
          });
        }
      })
      .catch(function() { /* offline: mantém sessão local */ });
  }
})();

// ============================================================
// Re-aceite dos termos: quando user logado tem terms_version != atual,
// mostra modal. Tambem trata erros estruturados do backend
// (TERMS_OUTDATED, NO_DOCUMENTS) que vem do middleware requireBidEligible.
// ============================================================
function showTermsReacceptModal() {
  var modal = document.getElementById('terms-reaccept-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('terms-reaccept-check').checked = false;
  document.getElementById('terms-reaccept-error').textContent = '';
}

function hideTermsReacceptModal() {
  var modal = document.getElementById('terms-reaccept-modal');
  if (modal) modal.style.display = 'none';
}

function logoutFromTermsModal() {
  hideTermsReacceptModal();
  if (typeof logout === 'function') logout();
}

async function confirmReacceptTerms() {
  if (!document.getElementById('terms-reaccept-check').checked) {
    document.getElementById('terms-reaccept-error').textContent = 'Você precisa marcar o aceite pra continuar.';
    return;
  }
  var btn = document.getElementById('terms-reaccept-btn');
  var original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Salvando...';
  try {
    var token = localStorage.getItem('lp_token');
    var res = await fetch('/api/auth/me/accept-terms', { method:'POST', headers: { 'Authorization': 'Bearer ' + token } });
    var j = await res.json();
    // Token expirado/invalido = sessao morta. Limpa e pede login.
    if (res.status === 401 || (j && (j.error === 'Token inválido' || j.error === 'Faça login'))) {
      hideTermsReacceptModal();
      if (typeof handleSessionExpired === 'function') handleSessionExpired();
      else {
        localStorage.removeItem('lp_token');
        localStorage.removeItem('lp_user');
        if (typeof showToast === 'function') showToast('Sua sessão expirou. Faça login novamente.', 'warning', 6000);
        if (typeof openModal === 'function') setTimeout(openModal, 400);
      }
      return;
    }
    if (!j.success) throw new Error(j.error || 'falha');
    hideTermsReacceptModal();
    if (typeof showToast === 'function') showToast('Termos aceitos. Já pode dar lance!', 'success', 4000);
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = original;
    document.getElementById('terms-reaccept-error').textContent = 'Erro: ' + e.message;
  }
}

// Checagem no boot: se logado e nao for admin, pergunta ao servidor se a
// versao dos termos do usuario bate com a atual. Se nao, mostra modal.
(function checkTermsOnBoot() {
  var token = localStorage.getItem('lp_token');
  var u = localStorage.getItem('lp_user');
  if (!token || !u) return;
  try {
    var parsed = JSON.parse(u);
    if (parsed && parsed.role === 'admin') return;
  } catch (e) { /* segue */ }
  fetch('/api/auth/me/terms-status', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (j && j.success && j.up_to_date === false) {
        // Pequeno delay pra nao competir com outros toasts/modals iniciais
        setTimeout(showTermsReacceptModal, 1200);
      }
    })
    .catch(function() { /* offline: ignora */ });
})();
