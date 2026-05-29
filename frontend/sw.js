// Service worker MÍNIMO. NÃO cacheia nada — durante leilão ao vivo, cache
// errado entregaria preço/tempo velho. Existir já é suficiente pra o Chrome
// considerar o site "instalável" como PWA (a tela de "Adicionar à tela
// inicial" / botão de instalar aparece). iOS nem usa SW pra isso, então
// não tem como sair errado.

self.addEventListener('install', function(event) {
  // Pula a fila de espera: nova versão entra no ar na hora.
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  // Assume controle de abas abertas imediatamente.
  event.waitUntil(self.clients.claim());
});

// Fetch totalmente passivo: tudo vai pra rede como se o SW não existisse.
// (Ter o handler é o que torna o site "instalável" no Chrome/Android.)
self.addEventListener('fetch', function(event) {
  // Não chama event.respondWith — o navegador faz o fetch normal sozinho.
});
