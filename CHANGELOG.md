# Changelog

## Não lançado

### Segurança

- `glpi_upload_document` só lê arquivos dentro de `GLPI_UPLOAD_DIR` (symlinks
  são resolvidos e o tamanho é limitado por `GLPI_MAX_UPLOAD_BYTES`). Com a
  variável sem valor, o envio de arquivos fica desabilitado. Antes, qualquer
  caminho legível podia ser enviado.
- `GLPI_READ_ONLY=1` remove todas as ferramentas de escrita da lista e as
  rejeita no momento da chamada.
- `itemtype` é validado (`[A-Za-z][A-Za-z0-9_]*`) antes de entrar no caminho da
  requisição.
- `GLPI_URL` precisa ser `https://` (exceto loopback, ou
  `GLPI_ALLOW_INSECURE_HTTP=1`).
- Requisições POST não são mais repetidas em erro de rede ou 5xx, o que podia
  duplicar chamados, acompanhamentos e envios de arquivo.
- Corpos de erro do GLPI devolvidos ao modelo são cortados em 200 caracteres.

### Alterado

- Descrições das ferramentas e dos recursos em português do Brasil.
- Rótulos de status, urgência e validação em português, seguindo os nomes do
  GLPI pt_BR (ex.: `Solucionado`, `Em atendimento (atribuído)`). Isso muda os
  valores de `status`, `urgency`, `status_label` e as chaves devolvidas por
  `glpi_tickets_stats_by` com `dimension: "status"`.
- `resolveField` ignora maiúsculas e acentos ao comparar o nome do campo
  (`titulo` casa com `Título`).
- Um campo que não existe nos critérios de busca agora gera `InvalidParams`.
  Antes, era trocado silenciosamente pelo campo `0`.
- Dependências atualizadas com `npm audit fix` (0 vulnerabilidades).

## 3.3.0 — 2026-08-05

### Adicionado

- **`glpi_upload_document`**: envia um arquivo local como Documento do GLPI via
  `POST /Document` multipart (`uploadManifest` + `filename[0]`), com um
  `ticket_id` opcional que vincula o documento ao chamado na mesma chamada. O
  vínculo é declarado dentro do manifesto (`itemtype`/`items_id`), então também
  funciona para perfis restritos (ex.: requerentes do Self-Service) que não
  podem fazer `POST Document_Item` diretamente. O tipo MIME vem da extensão do
  arquivo.
- Opção `form` na camada HTTP (`GlpiHttp.request`) para corpos multipart: o
  `Content-Type` JSON é omitido para o `fetch` definir o boundary. O manifesto
  precisa ser anexado como campo de texto simples, porque partes com nome de
  arquivo vão para `$_FILES` do PHP e o GLPI lê o manifesto de `$_POST`.
- Testes: tratamento de cabeçalhos multipart, montagem do par
  manifesto/arquivo, vínculo ao item pelo manifesto e nome padrão do documento
  (`test/upload.test.ts`).

## 3.2.0 — 2026-07-04

### Adicionado

- **Anotações de segurança MCP** nas 84 ferramentas (corrige #3, achados do
  AgentSeal):
  - `readOnlyHint: true` em toda ferramenta de list/get/search/count/stats
    (56 ferramentas).
  - `destructiveHint: true` nas ferramentas de delete/update/set/assign (9
    ferramentas): os agentes recebem um sinal explícito antes de chamar
    `glpi_delete_ticket`, `glpi_delete_computer`, `glpi_update_*` etc.
  - `idempotentHint` e `openWorldHint: false` em todas (as ferramentas só
    alcançam a instância do GLPI configurada).
  - As anotações são derivadas do nome da ferramenta, então ferramentas futuras
    são anotadas automaticamente.
- **Teste de fumaça ao vivo** (`npm run smoke`, `npm run smoke -- --write`):
  23 verificações contra uma instância real: sessão, cache de SearchOptions,
  resolução de campos, count/search/stats, linha do tempo,
  usuários/computadores/grupos/entidades e um ciclo de escrita opcional (criar
  chamado de teste → acompanhamento → renomear → exclusão lógica → conferir a
  lixeira). Lê as credenciais do ambiente ou do `.env` (ignorado pelo git).
  Validado contra o GLPI 11 (idioma francês).

### Corrigido

- **Erro de um a mais na busca**: `search()` passava `limit` como fim do
  intervalo, mas os intervalos do GLPI são inclusivos, então `limit: 5`
  devolvia 6 linhas. Afetava `glpi_search_v2`, `glpi_search_tickets`, os
  caminhos próximos de `glpi_count` e o filtro de usuários ativos. Encontrado
  pelo teste de fumaça ao vivo.
- **`resolveField` falhava em instâncias traduzidas**: a resolução por nome
  amigável só comparava o rótulo traduzido ("Statut" num GLPI em francês),
  então `resolveField('Ticket', 'status')` devolvia undefined. Agora a
  resolução tenta, em ordem: uid explícito → uid canônico da própria tabela
  (`Ticket.status`) → rótulo traduzido → nome da coluna SQL, com prioridade para
  a própria tabela quando há colisão de colunas (ex.: `name` existe em
  glpi_tickets e em glpi_users, que é juntada).

## 3.1.0 — 2026-07-04

Reforço de confiabilidade após a auditoria da v3.0.0.

### Adicionado

- **Timeout de requisições**: toda chamada HTTP (incluindo `initSession`) é
  envolvida por um `AbortController` com timeout configurável
  (`GLPI_TIMEOUT_MS`, padrão 15 s). Um backend do GLPI travado não bloqueia
  mais o servidor MCP indefinidamente.
- **Retry em `429` e erros de rede**: respostas com limite de taxa respeitam o
  cabeçalho `Retry-After`; falhas transitórias de rede (ECONNRESET, timeouts)
  são repetidas com o mesmo backoff exponencial do `5xx`.
- **Validação de entrada em tempo de execução (zod)** nas ferramentas de
  chamados (`glpi_list_tickets`, `glpi_get_ticket`, `glpi_search_tickets`):
  argumentos inválidos retornam um erro MCP `InvalidParams` claro em vez de
  falhar mais adiante no GLPI.
- **Erros MCP diferenciados**: validação zod → `InvalidParams`; `GlpiError` →
  mensagem com status HTTP + código do GLPI; todo o resto → `InternalError`.
- **Validação da configuração na partida**: `GLPI_URL` precisa ser uma URL
  válida e um método de autenticação precisa estar configurado; falha rápido
  com mensagem clara.
- **Log de depuração** (`GLPI_DEBUG=1`): retries, reautenticação e eventos de
  limite de taxa vão para o stderr (o stdout continua reservado ao transporte
  stdio do MCP).
- **Partida resiliente**: se o GLPI estiver inacessível quando o servidor
  inicia, é registrado um aviso e a sessão é aberta sob demanda na primeira
  requisição (antes o servidor encerrava na hora).
- Novas variáveis de ambiente: `GLPI_TIMEOUT_MS`, `GLPI_MAX_RETRIES`,
  `GLPI_DEBUG`.
- 3 novos testes da camada HTTP (abort por timeout, retry em 429, retry em erro
  de rede), 7 no total.

## 3.0.0 — 2026-06-08

Reformulação grande, focada nas fundações e na cobertura de ITSM e relatórios.

### Adicionado

- **Camada HTTP unificada** (`src/http.ts`) com:
  - Reautenticação automática em `401` (`session_token` expirado).
  - Retry com backoff exponencial em `5xx`.
  - `GlpiError` estruturado, expondo status HTTP + código/mensagem de erro do
    GLPI + corpo.
- **Busca com múltiplos critérios** pelo novo `GlpiSearch` de alto nível
  (`src/search.ts`):
  - Array de critérios com operador `link` (`AND` / `OR` / `AND NOT` /
    `OR NOT`).
  - `forcedisplay` para escolher as colunas devolvidas.
  - Paginação por `start`/`limit`, `fetch_all` com limite de segurança
    `max_rows` (padrão 1000).
  - Lê `totalcount` e o cabeçalho `Content-Range`.
- **`SearchOptionsCache`** (`src/search-options.ts`): guarda em cache
  `/listSearchOptions/{itemtype}` (TTL de 1h) para que as ferramentas de alto
  nível traduzam nomes amigáveis ↔ `field_id` sem quebrar entre versões do GLPI.
- **Novas ferramentas MCP**:
  - `glpi_count`: sonda barata de totalcount (range=0-0) com critérios.
  - `glpi_search_v2`: busca com múltiplos critérios; `glpi_search` fica como
    alias obsoleto.
  - `glpi_list_search_options`: descobre os ids de campo de um itemtype.
  - `glpi_search_tickets`: parâmetros amigáveis (status, assigned_user/group,
    requester, category, entity, priority, urgency, date_from/to, text_search,
    open_only) traduzidos internamente para critérios.
  - `glpi_get_ticket_timeline`: acompanhamentos + tarefas + soluções +
    validações combinados e ordenados cronologicamente.
  - `glpi_tickets_stats_by(dimension, period)`: contagens agrupadas por
    status / categoria / técnico / entidade / mês.
  - `glpi_link_tickets`: relações Ticket_Ticket (vínculo / duplicado / pai).
  - `glpi_add_ticket_validation`, `glpi_set_validation_status`,
    `glpi_get_ticket_validations`.
  - `glpi_attach_document_to_ticket`, `glpi_get_ticket_documents`.
  - `glpi_get_ticket_satisfaction`, `glpi_list_overdue_tickets`.
  - `glpi_get_ticket_solutions`.
  - `update`/`delete` simétricos em Monitor, Phone, Printer, Software e
    NetworkEquipment (paridade com Computer).
- **`expand_dropdowns=true` por padrão** em todas as leituras de detalhe: os
  ids de chaves estrangeiras voltam resolvidos (nome do técnico, rótulo da
  categoria, entidade etc.), e os ids brutos continuam disponíveis ao lado.
- **Testes**: testes de integração mínimos com `node --test` + `tsx` (camada
  HTTP, reautenticação, retry, leitura de erros).

### Corrigido

- **F9**: as estatísticas de chamados e ativos não buscam mais até 9999 linhas
  só para contá-las: usam critérios + sondas de totalcount com `range=0-0`.
  Preciso além de 10 mil chamados e bem mais rápido.
- **F10**: o filtro `active_only` de `glpi_list_users` usava `searchText` (LIKE
  numa coluna de rótulo), o que dava resultados errados sem avisar. Agora usa o
  endpoint de busca com `criteria=is_active equals 1`.
- **F12**: `glpi_assign_ticket` ignorava `group_id`. Agora envia para
  `Group_Ticket` quando há grupo e para `Ticket_User` quando há usuário.
- `glpi_search_knowbase` não fixa mais `field=6` para o título; o id do campo é
  resolvido por `listSearchOptions/KnowbaseItem`.

### Alterado (incompatível)

- **Construtor de `GlpiClient`**: mesmo formato (`GlpiConfig`), mas a camada
  interna de fetch/sessão/erro agora é a `GlpiHttp`. Os métodos de domínio
  públicos mantêm os nomes da v2 e o comportamento foi reforçado (veja
  Corrigido).
- **Ferramentas `glpi_list_*`**: agora aceitam `start`, `range`, `sort`,
  `order` e `expand_dropdowns`. A forma antiga só com `limit` continua
  funcionando.
- **`glpi_search`**: marcada como obsoleta. Prefira `glpi_search_v2`.
- **Alvo de build**: TypeScript já era `strict`; a execução de testes passa a
  usar `tsx` em vez de `jest`/`ts-node`.

### Removido

- O `eslint` era citado nos scripts do `package.json`, mas nunca foi
  instalado; o script sem uso foi removido para evitar confusão. O lint pode
  voltar junto com os testes, se necessário.
