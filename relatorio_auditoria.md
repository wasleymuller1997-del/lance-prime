# Relatório de Auditoria de Segurança e Código - LancePrime

**Data:** 21 de Maio de 2026
**Projeto:** LancePrime (wasleymuller1997-del/lance-prime)
**Autor:** Manus AI

## 1. Visão Geral

Foi realizada uma varredura completa no repositório do projeto LancePrime, abrangendo o backend (Node.js/Express), frontend (HTML/JS) e configurações. O projeto apresenta uma estrutura funcional para um sistema de leilão e venda direta. No entanto, foram identificadas falhas críticas de segurança que comprometem a integridade dos dados, a privacidade dos usuários e a segurança financeira da plataforma.

Abaixo estão detalhadas as vulnerabilidades encontradas, classificadas por nível de criticidade, juntamente com as recomendações de correção.

## 2. Falhas Críticas (Risco Alto)

A auditoria revelou diversas vulnerabilidades de alto risco que exigem correção imediata antes de qualquer implantação em ambiente de produção. A tabela a seguir resume os problemas críticos encontrados.

| Vulnerabilidade | Arquivo(s) Afetado(s) | Descrição e Impacto | Recomendação de Correção |
| :--- | :--- | :--- | :--- |
| **Credenciais Hardcoded e Expostas** | `backend/src/routes/auth.js`, `backend/src/routes/vehicles.js`, `.env.example` | Senhas de administrador e credenciais de APIs externas estão fixas no código-fonte. O arquivo `.env.example` contém senhas reais expostas publicamente. Qualquer pessoa com acesso ao repositório pode assumir o controle total do sistema. | Remover todas as credenciais do código-fonte e utilizar variáveis de ambiente (`.env`). Alterar imediatamente as senhas expostas no repositório público. |
| **Falha de Autenticação (Broken Access Control)** | `backend/src/routes/pix.js`, `backend/src/routes/vehicles.js` | Rotas administrativas (como `GET /admin/pix`, `GET /admin/bids` e `GET /admin/user/:id/profile`) não utilizam o middleware de verificação de administrador. Qualquer usuário pode acessar dados sensíveis e históricos financeiros. | Aplicar o middleware `requireAdmin` em todas as rotas que começam com `/admin/` para garantir que apenas administradores tenham acesso. |
| **Vulnerabilidade no Webhook de Pagamento** | `backend/src/routes/pix.js` | A rota `POST /webhooks/nuvende` aceita requisições sem validação de assinatura ou token. Um atacante pode forjar requisições e marcar cobranças PIX como pagas no banco de dados. | Implementar validação de assinatura (HMAC) ou exigir um token de autorização específico no header do webhook. |
| **Segredo JWT com Fallback Inseguro** | `backend/src/routes/pix.js`, `backend/src/routes/vehicles.js` | A verificação do token JWT utiliza um fallback hardcoded (`lance-prime-secret-2024`). Se a variável de ambiente falhar, um atacante pode forjar tokens válidos como administrador. | Remover o fallback do código. O sistema deve falhar na inicialização se a variável `JWT_SECRET` não estiver definida. |
| **Server-Side Request Forgery (SSRF)** | `backend/src/routes/vehicles.js` | As rotas `GET /laudo-proxy` e `GET /img` aceitam qualquer URL via parâmetro e fazem requisições HTTP sem validação. Isso permite que atacantes usem o servidor para acessar redes internas. | Validar rigorosamente a URL fornecida, permitindo apenas domínios específicos (whitelist) conhecidos e confiáveis. |

## 3. Falhas Moderadas (Risco Médio)

Além das falhas críticas, foram identificados problemas de segurança de risco médio que, embora não permitam o comprometimento imediato do sistema, enfraquecem a postura de segurança geral da aplicação.

| Vulnerabilidade | Arquivo(s) Afetado(s) | Descrição e Impacto | Recomendação de Correção |
| :--- | :--- | :--- | :--- |
| **Senhas em Texto Plano** | `backend/src/services/db.js`, `backend/src/routes/vehicles.js` | A tabela `dealers_accounts` armazena senhas em texto plano. Em caso de vazamento do banco de dados, as credenciais de terceiros estarão expostas. | Criptografar as senhas antes de salvá-las no banco de dados ou utilizar um serviço de gerenciamento de chaves (KMS). |
| **Ausência de Proteções Básicas** | `backend/src/server.js` | O servidor não utiliza bibliotecas para configurar headers de segurança ou limitar requisições (rate limit). O sistema fica vulnerável a ataques de força bruta e negação de serviço (DDoS). | Instalar e configurar bibliotecas como `helmet` e `express-rate-limit`, focando especialmente nas rotas de autenticação. |
| **Cross-Site Scripting (XSS)** | `frontend/js/app.js`, `frontend/admin.html` | O frontend faz uso extensivo de `innerHTML` para renderizar dados da API sem sanitização. Um atacante pode inserir scripts maliciosos que serão executados nos navegadores de outros usuários. | Substituir `innerHTML` por `textContent` ou utilizar uma biblioteca de sanitização como `DOMPurify` para tratar os dados antes da renderização. |

## 4. Problemas de Lógica e Boas Práticas

Durante a análise do código, também foram observadas práticas de desenvolvimento que afetam o desempenho e a confiabilidade do sistema.

O frontend realiza um polling agressivo, fazendo requisições para a rota de veículos a cada um segundo. Isso gera uma carga massiva e desnecessária no servidor e no banco de dados, especialmente considerando que o sistema já possui uma infraestrutura de WebSocket implementada para atualizações em tempo real. É altamente recomendável remover esse polling e confiar exclusivamente no WebSocket para a sincronização de lances e preços.

Adicionalmente, o servidor WebSocket aceita conexões de qualquer cliente e realiza o broadcast de todos os lances sem verificar a autenticação do usuário. Isso resulta no vazamento de informações de negócios em tempo real para visitantes não autenticados. A solução adequada é exigir o envio do token JWT durante a conexão do WebSocket e validar a identidade do usuário antes de permitir a inscrição nos canais de atualização.

Por fim, o tratamento de erros no backend frequentemente retorna mensagens de erro brutas ou a pilha de execução (stack trace) diretamente para o cliente. Esse comportamento vaza detalhes internos da infraestrutura e do banco de dados. A recomendação é registrar o erro completo internamente no servidor e retornar apenas mensagens genéricas e seguras para o usuário final.

## 5. Conclusão

O projeto LancePrime possui uma base sólida para a sua finalidade, mas requer atenção imediata às falhas críticas listadas na Seção 2 antes de qualquer implantação. A prioridade máxima deve ser a remoção de credenciais hardcoded, a proteção rigorosa das rotas administrativas e a implementação de segurança no webhook de pagamentos PIX. A correção dessas vulnerabilidades garantirá um ambiente seguro e confiável para os usuários e administradores da plataforma.
