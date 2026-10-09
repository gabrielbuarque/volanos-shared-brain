# Redesign da interface do Shared Brain

Reconstrução do frontend (`public/`) com o Volanos Design System e com a experiência "Perguntar".
O backend de permissões (P0 a P12, filtro antes da IA, fila de aprovação, versões, aging, export, auditoria) **não mudou de modelo**: só ganhou rotas novas que o usam.

- Antes: `antes/` (Home, chat, Memories, Admin; 1280px e 390px).
- Depois: `depois/` (as mesmas telas e larguras, mais as telas novas).
- Pacote de design: `Volanos Design System.zip`, sem modificar. Hierarquia: BrandBook > skill `volanos-branding` > pacote.

## O que mudou

| Área | Antes | Depois |
| --- | --- | --- |
| Estilos | `main.css` (4.603 linhas) + `volanos.css` por cima | `tokens.css` (do pacote), `base.css`, `components.css`, `app.css`, `styleguide.css`. Nenhum hex fora de `tokens.css` (teste) |
| Componentes | HTML por string | `public/js/ui/`: funções que devolvem elementos (Button, IconButton, Card, LevelPill, Tag, Tabs, Input, Select, Checkbox, Switch, Dialog, Toast, Tooltip, Eyebrow, Statement, Rule, Logo, Icon) |
| Navegação | Home, Memories, Team, grafo, coach, patterns | Topo fixo com logo, seletor de cliente e perfil com o nível. Quatro áreas: Perguntar, Clientes, Contribuir, Admin |
| Resposta | texto + fontes recolhidas | frase direta, pontos com chips `[n]`, cartões de fonte, escopo, três ações, estados de espera, vazio, conflito, fonte antiga e erro |
| Tema | claro, escuro e automático | só claro. Gradiente navy só no login e nas boas-vindas |
| Ícones / fontes | Tabler via CDN | subset Lucide embutido; Montserrat e Merriweather locais |
| Idiomas | en, it | pt-BR e en (`i18n-pt.js`, `i18n-en.js`) |

Removidos: Memories, grafo, coach, patterns, brief, Remember, tema escuro e 41 testes de UI que cobriam essas telas. O que ainda servia foi para **Admin > Avançado**: modelo de IA, textos dos níveis, saúde da memória (aging), exportação, sobre.

### Rotas e API novas

- `GET /recall?client=<id|internal>`: o escopo de cliente **soma-se** ao filtro de nível, workspace e ACL (`src/recall/search.ts`, `src/lib/clients.ts`). Por fonte devolve `client_id`, `author`, `updated_at`, `clearance_level`, `review_state`, `stale`; mais `conflicts` (pares divergentes). Contrato em `test/integration/recall-contract.test.ts`.
- `GET /clients`: só clientes em que a pessoa lê ao menos uma fonte; contagem e data vêm só do que ela lê.
- `GET /client/entries`: Canon e fontes do cliente, filtráveis por nível.
- `POST /entry/propose-edit` (proposta de edição de documento; admin e publicação direta aplicam na hora), `GET /entry/versions` agora traz `actor_name`.
- `POST /conflicts/flag`, `POST /canon/propose`, `POST /contributions/suggest`, `POST /contributions/submit`, `GET /admin/audit`, `POST /admin/view-as/start`.
- Header `X-View-As` (admin): a identidade da pessoa escolhida entra no **mesmo** caminho de filtro. Somente leitura (a única exceção é `POST /chat`).
- `/entry` passou a devolver `client_id` e `review_state`. `/permissions/me` devolve nome, e-mail e `viewAs`.
- Prompt de resposta em `src/recall/answer-prompt.ts` (frase-resumo, citação em toda afirmação, `[not-found]`, nada de conhecimento geral sem marca, sem pergunta aberta no fim).

## Decisões onde o DS não cobria

**Cliente = diretório.** Não havia entidade de cliente. Um cliente é um `brain_directories` (já tem dono, ACL e nome); `directory_id` é o `client_id`. Memória sem diretório é "Volanos interno". Nenhuma mudança de schema.

**Estado sem cor.** O DS não tem verde, âmbar nem vermelho.
- Nível: forma, não tom. P0 a P3 preenchido navy, P4 a P8 contorno navy, P9 a P12 cinza neutro; o texto "P7" sempre aparece e o tooltip traz a definição do nível.
- Revisão: Verificado (Tag cheia), Rascunho e Revisado (contorno), "Não revisado" (cinza). Mapeia tags que já existiam: `status:canonical`, `approved`, `status:draft`.
- Fonte antiga: Tag de contorno com borda de 2px e o texto "Pode estar desatualizada" (corte de 180 dias do memory aging).
- Conflito e erro: borda navy mais grossa (2px e 3px) mais texto.
- Desabilitado: cinza sólido da paleta, não opacidade sobre o navy.
- Seleção e destaque da citação: Light Blue, único uso além do foco.

**Foco.** Anel de 3px em Light Blue como `outline` (e não `box-shadow`), para não violar "nenhuma sombra fora de hover e diálogo". Pendente para a Karen: o Light Blue sobre Off-White dá cerca de 1,6:1 de contraste, abaixo dos 3:1 que a WCAG pede para indicadores de foco. Os campos também trocam a borda para navy no foco, o que ajuda, mas botões em fundo claro dependem só do anel.

**Tipografia de app.** O DS mede corpo em 19px; interface densa usa o degrau de 15px (`--fs-ui`) e legendas em 13px. Leitura de documento e resposta usam 18 a 19px. Títulos de página em Montserrat 300. O `Statement` "all-Merriweather" do pacote não foi usado: pela regra do projeto, Merriweather só na virada e nos títulos do Canon.

**Padrões de app sem referência no DS:** topo fixo (borda hairline, sem sombra), seletor de cliente em `Select`, matriz pessoas x níveis, faixa fixa do "Ver como" em navy, esqueleto em cinza neutro (sem animação), cartão de fonte, dropzone com borda tracejada, toast em região viva.

**Fila de contribuição sem coluna nova.** `contributions.doc_id` guarda `client:<id>` e `reason` guarda `client-contribution` ou `canon-proposal`. Evita mexer no schema e nos guard tests. O dono do cliente vê o item mesmo sem ser P0, **desde que o nível do item esteja no alcance dele** (nível sugerido >= piso). Proposta de Canon nasce no nível mais restrito das fontes usadas.

**Revisão do Canon.** "Salvar no Canon" cria um item `canon-proposal`; ao aprovar, a memória ganha `status:canonical` no diretório do cliente.

**Sugestão da IA em Contribuir.** Modelo (Workers AI por padrão, sem nível conhecido, então só provedores restritos) com fallback por regras: cliente mais citado no nome do arquivo e no texto, nível = piso de quem envia. A pessoa sempre confirma.

**Ver como.** `X-View-As` é resolvido em `requireIdentity`. O Admin some enquanto a visão está ativa; rotas de admin respondem 403 porque a identidade que chega a elas é a da pessoa. Cada início é auditado (`view_as_started`).

**Servidor de desenvolvimento em Node.** O `wrangler dev` não sobe neste Windows (`spawn UNKNOWN` do workerd; é também por isso que 2 testes de ambiente falham aqui). `npm run dev:node` roda o mesmo Worker sobre SQLite em memória com o seed de demonstração e **IA simulada**. Serve para revisar a interface, nunca para produção.

## Segunda rodada: testes no navegador, HIG da Apple e PRD

Referência do PRD: `Volanos_Shared_Brain_Arquitetura_e_Plano.pdf` (15 slides; não há outro arquivo de PRD na pasta). A interface foi testada no navegador com scripts em `scripts/e2e/` (Edge via CDP, servidor `npm run dev:node`): pergunta e resposta, estados de erro, parar, troca de cliente no meio da resposta, sessão expirada, entradas estranhas, convites, ver como, matriz, ciclo completo "Tito contribui, Letícia encontra", teclado e medição de HIG.

### O que o teste achou e foi corrigido

| Achado | Correção |
| --- | --- |
| Perguntar exigia escolher o cliente antes. Quem não sabe onde está o conteúdo não descobria nada (o PRD pede descobrir sem localizar quem estava na conversa) | Seletor ganhou **Todos os clientes** (padrão). Sem escopo de cliente; nível, workspace e ACL continuam no SQL. Em "todos", os atalhos preenchem o começo da pergunta |
| Conflito entre clientes diferentes seria falso (a meta de um não contradiz a do outro) | O par só conta dentro do mesmo cliente (`findSourceConflicts`) |
| O PRD define precedência (canônica do owner, depois fonte oficial, depois recência, repetição não decide). A tela só dizia "mais recente" | Cartão do conflito mostra quem **prevalece e por quê** (canônica, revisada, mais recente) e a regra. O prompt de resposta passou a exigir a mesma ordem. A autoridade por papel do autor ainda não entra (o `/recall` não devolve o papel) |
| Sem brain pessoal. O PRD tem Private + Shared e "nem o admin acessa" | Contribuir ganhou **Salvar só para mim** e a aba **Meu espaço** (listar, enviar ao Shared Brain, esquecer). Fontes privadas levam a etiqueta Privado e a resposta avisa. Em "Salvar no Canon" as notas privadas ficam de fora. Verificado: o admin não encontra a nota de outra pessoa |
| Sem histórico, diff nem rollback. O PRD chama versionamento de obrigatório | Documento ganhou **Histórico** (versões, quem, o que mudou, restaurar) usando `/entry/versions` e `/entry/restore`, que já filtram por nível |
| Sem edição. O fluxo do PRD é propor, revisar com diff, aprovar | **Propor edição** no documento. A fila mostra o que muda (diff). Admin e quem tem publicação direta aplicam na hora. Nova rota `POST /entry/propose-edit`; aprovar usa `applyDocumentEdit`, que guarda a versão antiga e **preserva as quebras de linha** (o `/update` do upstream achata espaços e destruiria cabeçalhos e listas) |
| Admin sem suspender, remover nem gerar token (existiam no backend) | Em Pessoas, "Mais": suspender/restaurar, novo token (mostrado uma vez) e remover (confirmação) |
| Convite: e-mail inválido aparecia como balão nativo; duplicado criava outro; erros do servidor chegavam em inglês | Erro em linha junto do campo, aviso de convite já aberto, mensagens em português |
| Copy insinuava conteúdo restrito ("Ele não existe ou está acima do seu nível", "Você só vê fontes do seu nível") | Trocado por texto neutro. Documento ou cliente fora do alcance responde igual a um que não existe |
| Primeira frase repetida como primeiro ponto | A resposta descarta o ponto idêntico à frase direta |
| Conflito sem valor extraído mostrava o título duas vezes | O valor só aparece quando existe |
| Visão "ver como" ainda deixava abrir Contribuir (escrita) | Contribuir some e a rota volta para Perguntar |
| Pergunta de 30 mil caracteres estourava a URL (431) | Campo limitado a 2.000 caracteres |
| Título da página igual em todas as telas | `Perguntar · Volanos Shared Brain`, etc. |

### Auditoria pelo HIG (medida no navegador)

| Critério | Antes | Depois |
| --- | --- | --- |
| Alvos de toque no celular (44 pt) | abas, botões, chips e seletor com 27 a 40 px | 44 px em tudo que se toca |
| Campos no celular | 13 e 15 px (o iOS amplia a tela ao focar) | 16 px |
| Texto mínimo | 10 e 11 px | 12 px |
| Contraste do texto funcional | 3,9:1 a 4,4:1 (cinza do DS) | acima de 4,5:1 (`--text-secondary`) |
| Navegação no celular | linha de links cortada ("ADMI") | barra inferior com quatro áreas e área segura |
| Pular para o conteúdo | não havia | link de pulo |
| Foco do teclado | anel presente | anel presente; diálogo prende o foco e o Esc fecha |

**Desvio do DS para revisar com a Karen:** o cinza dos kickers (`--grey-eyebrow`, #7B7B7B) dá 3,9:1 sobre o Off-White e o das legendas 4,4:1. Para texto de navegação, abas, legendas, metadados e rótulos usamos o navy a 70% (`--text-secondary`, #4A5670). O anel de foco em Light Blue continua com cerca de 1,6:1 (pendência acima).

### O que o PRD pede e ainda não está na interface

| PRD | Situação |
| --- | --- |
| Tenants (Volanos, Jori, IndiqAI) com troca de organização | Não. O backend tem workspaces (`/team/workspaces`), mas o modelo de cliente do redesign é o diretório. Decidir se Jori e IndiqAI são clientes ou tenants antes de desenhar |
| Revisão: "pedir contexto" além de aprovar, editar e recusar | Não. Precisa de um estado novo na fila (hoje só pendente, aprovado, recusado) |
| Revisão: diff para conteúdo novo e "impacto" | Diff só existe para edição de documento. Impacto (o que muda nas respostas) não existe |
| Ciclo de vida: ativo, arquivado, substituído, rejeitado | Mostramos versão ativa e histórico. Arquivar e substituir pela interface não existe (o backend tem `archive` e `merge`) |
| Proveniência por agente ("alterada pelo agente de André") | Mostramos pessoa, data e origem; o agente não é registrado |
| Autoridade da fonte na precedência (owner ou gerente pesam mais que nota casual) | Só canônica, revisada e recência |
| Padrão de captura por pessoa (privado ou compartilhado) | Existe no backend (`default-share`); a interface sempre pergunta |
| Atividade do time e padrões semanais | Saíram da navegação, como o prompt pediu; seguem no backend |
| Edição de nota privada | A nota é salva achatada (o `/capture` do upstream junta linhas). Vale revisar antes de usar notas longas |

## Ferramentas

- `scripts/seed-demo-volanos.mjs`: seed sintético (Dique, Aurora Têxtil, Volanos interno; P0, P6, P8, P12; metas contraditórias; fonte com mais de 180 dias). `--out arquivo.sql` ou `--apply` (D1 local; recusa remoto).
- `scripts/capture-screens.mjs --set antes|depois [--audit]`: capturas em 1280 e 390px via Edge/CDP e auditoria de marca no navegador (`scripts/brand-audit-page.js`).
- `scripts/e2e/*.mjs`: testes ponta a ponta no navegador contra `npm run dev:node` (`node scripts/e2e/qa.mjs`, `cycle.mjs`, `hig.mjs`, `stress.mjs`, `keyboard.mjs`...). Ferramenta de revisão, não entra no `npm test`.
- `test/integration/edit-proposal.test.ts`: proposta de edição (diff, versão, quebras de linha, nível, dono do cliente).
- `test/ui/brand-checklist.test.ts`: portão estático (cores só em tokens, sombras, fontes, movimento, voz dos catálogos, paridade pt/en).
- `test/integration/demo-seed.test.ts`: a mesma pergunta sobre a Dique como P0 inclui o trecho P0; como P8 não inclui nem sinaliza; trocar de cliente não traz nada da Dique.

## Pendente para a Karen revisar

1. Contraste do anel de foco em Light Blue (acima).
2. Merriweather itálico: o arquivo local (`merriweather-italic.woff2`, 89 KB) é um subset; a variável completa do pacote tem 4,5 MB. Confirmar se o peso renderizado é o desejado.
3. Montserrat 300 vem da variável completa (688 KB), carregada só quando há texto leve. Vale gerar um subset latino em woff2.
4. Textos de PT-BR e EN (`i18n-pt.js`, `i18n-en.js`) passaram nas regras de voz por teste; falta olho humano.
5. Níveis P0 a P12 como forma (cheio, contorno, cinza): validar se três grupos bastam.
6. Ícone da marca para estados vazios (o subset Lucide não tem ícones de documento ou cadeado; os estados vazios usam só texto).
7. Italiano foi removido dos idiomas (a interface nova só tem pt-BR e en).

## Fora de escopo (registrado, não improvisado)

Deploy em produção, dados reais de clientes, mudanças no modelo de permissões, novos provedores de IA e merge com o upstream v4.0.0.
