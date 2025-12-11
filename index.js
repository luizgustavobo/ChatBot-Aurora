// Adiciona o dotenv para carregar as variáveis do arquivo .env (útil em desenvolvimento local)
require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios'); 
const fs = require('fs'); 

// ------------------------------------------------------------------
// --- CONFIGURAÇÃO RÁPIDA PARA TESTE LOCAL ---
// ------------------------------------------------------------------
const DELAY_MS = 2000; 
const delay = ms => new Promise(res => setTimeout(res, ms));

// URLs de Webhook agora carregadas das VARIÁVEIS DE AMBIENTE
const DISCORD_WEBHOOK_ALERTA = process.env.DISCORD_WEBHOOK_ALERTA; 
const DISCORD_WEBHOOK_METRICAS = process.env.DISCORD_WEBHOOK_METRICAS; 

// ------------------------------------------------------------------
// --- VARIÁVEIS GLOBAIS E PERSISTÊNCIA DE DADOS ---
// O restante do seu código permanece o mesmo...
// ------------------------------------------------------------------

const userStates = {}; 
const SEQUENCE_FILE = './protocol_sequence.txt';
let lastSequentialNumber = 0; 
const tipoSolicitacaoMap = {
    'lote_sujo': 1,
    'empresa': 2,
    'ocupacao_irregular': 3
};

// BANCO DE DADOS SIMULADO PARA STATUS DE PROTOCOLO
const protocolDatabase = {
    '2025.12.01.1.0001': { status: 'Finalizado com notificação', details: 'Notificação de limpeza emitida em 05/12/2025.' },
    '2025.12.05.2.0002': { status: 'Em Fiscalização', details: 'Fiscal designado para visita em 10/12/2025.' },
    '2025.12.08.1.0001': { status: 'Aguardando vistoria', details: 'Protocolo registrado e em fila de análise.' },
};


// ------------------------------------------------------------------
// --- FUNÇÕES DE PERSISTÊNCIA DE SEQUÊNCIA ---
// ------------------------------------------------------------------

/**
 * Carrega o último número sequencial do arquivo ao iniciar o bot.
 */
function loadLastSequence() {
    try {
        if (fs.existsSync(SEQUENCE_FILE)) {
            const data = fs.readFileSync(SEQUENCE_FILE, 'utf8');
            // Garante que o número carregado é um inteiro válido, senão usa 0
            lastSequentialNumber = parseInt(data) || 0;
            console.log(`[INFO] Último número sequencial carregado: ${lastSequentialNumber}`);
        }
    } catch (error) {
        console.error("[ERRO SEQ] Falha ao carregar sequência:", error.message);
    }
}

/**
 * Salva o número sequencial atual no arquivo após a geração de um novo protocolo.
 */
function saveLastSequence(number) {
    try {
        fs.writeFileSync(SEQUENCE_FILE, String(number), 'utf8');
    } catch (error) {
        console.error("[ERRO SEQ] Falha ao salvar sequência:", error.message);
    }
}

// ------------------------------------------------------------------
// --- FUNÇÕES AUXILIARES (PROTOCOLO, DISCORD E MENU) ---
// ------------------------------------------------------------------

/**
 * Gera o número de protocolo e salva o novo número sequencial.
 */
function generateProtocolNumber(typeKey) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    const typeNumber = tipoSolicitacaoMap[typeKey] || 9;
    
    // INCREMENTA E SALVA O NOVO NÚMERO
    lastSequentialNumber += 1;
    saveLastSequence(lastSequentialNumber); 
    
    const sequential = String(lastSequentialNumber).padStart(4, '0'); 

    return `${year}.${month}.${day}.${typeNumber}.${sequential}`;
}


async function sendToDiscord(title, fields, color = '3447003') { 
    
    // As variáveis de ambiente são usadas aqui
    let targetWebhook = DISCORD_WEBHOOK_ALERTA;

    if (title.includes("PESQUISA DE SATISFAÇÃO")) {
        targetWebhook = DISCORD_WEBHOOK_METRICAS;
    }
    
    if (!targetWebhook) {
        console.warn(`[AVISO DISCORD] URL do Webhook não configurado para: ${title}. Verifique as variáveis de ambiente.`);
        return;
    }
    
    const payload = {
        username: 'Aurora - Fiscalização Municipal', 
        embeds: [{
            title: title,
            color: color,
            timestamp: new Date().toISOString(),
            fields: fields,
            footer: {
                text: 'Via Chatbot WhatsApp'
            }
        }]
    };

    try {
        await axios.post(targetWebhook, payload);
        const webhookName = (targetWebhook === DISCORD_WEBHOOK_METRICAS) ? 'MÉTRICAS' : 'ALERTA';
        console.log(`[DISCORD - ${webhookName}] Alerta enviado: ${title}`);
    } catch (error) {
        console.error("[ERRO DISCORD] Falha ao enviar Webhook. Verifique a URL:", error.message);
    }
}


/**
 * Envia o Menu Principal com o nome do usuário em destaque.
 */
async function sendButtonMenu(to, nomeCidadao) {
    // PADRONIZADO: Nome do usuário e AURORA em **negrito**
    const saudacaoInicial = `👋 Olá, *${nomeCidadao}*, Seja Bem-Vindo(a)! 🤖 Sou a *AURORA*, Assistente Virtual do Setor de Fiscalização Municipal de Posturas. 🔹`;
    
    // PADRONIZADO: **Negrito**
    const menuOpcoes = `*Selecione uma opção digitando o número:*
1️⃣ Fazer Denúncia 🚨
2️⃣ Acompanhar Protocolo 📝
3️⃣ Comércio Ambulante (RCA) 📄
4️⃣ Falar com Atendente 💬`;

    // 1. Envia a saudação imediatamente
    await client.sendMessage(to, saudacaoInicial);
    
    // 2. Envia as opções de menu imediatamente após
    await client.sendMessage(to, menuOpcoes);
}


// ------------------------------------------------------------------
// --- CONFIGURAÇÃO DO CLIENTE WHATSAPP (OTIMIZADO PARA HOSPEDAGEM) ---
// ------------------------------------------------------------------

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // --- ALTERAÇÃO CRÍTICA PARA HOSPEDAGEM ---
        headless: true, 
        // Parâmetros de segurança e otimização para ambientes de servidor
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ], 
    }
});

// LÓGICA DO QR CODE
client.on('qr', (qr) => {
    // Exibe o QR code no console (para escanear remotamente)
    qrcode.generate(qr, { small: true });
    
    // Opcional: Salva a string do QR code em um arquivo caso o console do servidor não seja fácil de visualizar
    const qrFilePath = './qrcode_data.txt'; 
    try {
        fs.writeFileSync(qrFilePath, qr);
        console.log('\n======================================================');
        console.log('🚨 ESCANEIE O QR CODE NO CONSOLE.');
        console.log(`🚨 OU: Copie a string do QR code do arquivo: ${qrFilePath}`);
        console.log('======================================================');
    } catch (error) {
        console.error("[ERRO QR] Falha ao salvar o QR code:", error.message);
    }
});

client.on('ready', () => {
    console.log('\n✅ Cliente está pronto! O Bot Aurora está online e conectado.');
    
    // Carrega o último número sequencial do arquivo ao iniciar
    loadLastSequence(); 
    
    const qrFilePath = './qrcode_data.txt'; 
    if (fs.existsSync(qrFilePath)) {
        // Remove o arquivo QR code após a conexão bem-sucedida para fins de segurança/limpeza
        fs.unlinkSync(qrFilePath);
        console.log(`[INFO] Arquivo ${qrFilePath} removido.`);
    }
});

client.on('message', msg => {
    if (!msg.isGroup) {
        handleMessage(msg.from, msg); 
    }
});


// ------------------------------------------------------------------
// --- FUNÇÃO PARA TRATAR CHAMADAS ---
// ------------------------------------------------------------------
client.on('call', async (call) => {
    const userId = call.from;
    
    let nomeCidadao = 'Cidadão(ã)'; 
    try {
        const contact = await client.getContactById(userId);
        if (contact.pushname) {
            nomeCidadao = contact.pushname;
        }
    } catch (e) { /* Ignora */ }

    // PADRONIZADO: Nome e Negrito
    client.sendMessage(userId, `📞 *Atenção, *${nomeCidadao}*!* Este é um número de atendimento *Business* e aceita somente mensagens de texto. Selecione a opção desejada no menu.`);
    
    await sendButtonMenu(userId, nomeCidadao);
    
    userStates[userId] = null;
});


// ------------------------------------------------------------------
// --- FUNÇÃO DE LÓGICA DO CHATBOT (HANDLEMESSAGE) ---
// ------------------------------------------------------------------

async function handleMessage(to, msg) {
    let response = '';
    const userId = to; 
    const messageBody = msg.body ? msg.body.toLowerCase().trim() : '';
    const numericBody = msg.body ? msg.body.trim() : ''; 

    let nomeCidadao = 'Cidadão(ã)'; 
    
    // TENTATIVA 1: RÁPIDA - Puxar o nome de notificação da mensagem
    if (msg._data && msg._data.notifyName) {
        nomeCidadao = msg._data.notifyName;
    } 
    
    // TENTATIVA 2: CONFIÁVEL - Puxar o pushname do objeto Contact
    if (nomeCidadao === 'Cidadão(ã)') {
        try {
            const contact = await client.getContactById(to);
            if (contact.pushname) {
                nomeCidadao = contact.pushname;
            }
        } catch (e) { /* Mantém o default */ }
    }

    const currentState = userStates[userId];
    const isMenuCommand = ['oi', 'olá', 'ola', 'menu', 'boa tarde', 'boa noite', 'denunciar', 'lote', 'vizinho', 'bom dia'].includes(messageBody);

    // ------------------------------------------------------------------
    // --- Comandos de Menu, Reset e Botão Voltar (Entrada por Texto) ---
    // ------------------------------------------------------------------
    if (isMenuCommand || messageBody === 'voltar') { 
        
        userStates[userId] = null; 
        
        await sendButtonMenu(to, nomeCidadao);
        return; 
    
    // ------------------------------------------------------------------
    // --- TRATAMENTO DAS OPÇÕES DO MENU PRINCIPAL (Entrada por Número) ---
    // ------------------------------------------------------------------

    } else if (currentState === null && ['1', '2', '3', '4'].includes(numericBody)) {
        userStates[userId] = null; // Reseta o estado antes de iniciar um novo fluxo
        
        switch(numericBody) {
            case '1': // Denúncia
                userStates[userId] = 'denuncia_tipo'; 
                // PADRONIZADO: **Negrito**
                response = 'Certo. Qual o foco da sua denúncia? 🔎\n\n*Digite o número:* \n1️⃣ Denunciar lote sujo\n2️⃣ Empresa (Posturas)\n3️⃣ Ocupação irregular da via\n\n(Digite *voltar* para retornar ao menu principal.)';
                break;
            
            case '2': // Acompanhar Protocolo
                userStates[userId] = 'acompanhamento_protocolo';
                // PADRONIZADO: **Negrito**
                response = 'Para acompanhar sua solicitação, por favor, *digite o número do protocolo* (Ex: 2025.12.08.1.0001). 🔍\n\n(Digite **voltar** para retornar ao menu principal.)';
                break;
            
            case '3': // RCA
                try {
                    // Nota: O arquivo RCA.pdf deve estar na mesma pasta do bot no servidor.
                    const media = MessageMedia.fromFilePath('./RCA.pdf'); 
                    response = '✅ O documento RCA.pdf foi enviado. Digite *menu* ou *voltar* para ver as opções novamente.';
                    // PADRONIZADO: **Negrito**
                    await client.sendMessage(to, media, { caption: '*Segue o RCA (Regulamento de Comércio Ambulante) para sua consulta.* 🛍️' });
                } catch (error) {
                    // PADRONIZADO: **Negrito**
                    response = 'Desculpe, não consegui encontrar o documento *RCA.pdf* na pasta do bot. 😔 Digite *menu* ou *voltar* para ver as opções novamente.';
                }
                break;
                
            case '4': // Falar com Atendente
                const fields = [
                    { name: "Prioridade", value: "**ATENDIMENTO IMEDIATO**", inline: false },
                    { name: "Usuário", value: nomeCidadao, inline: true },
                    { name: "Contato WhatsApp", value: to, inline: true },
                    { name: "Instrução", value: "O usuário selecionou a opção de atendimento humano.", inline: false },
                ];
                await sendToDiscord("🟣 SOLICITAÇÃO DE ATENDIMENTO HUMANO (HANDOFF)", fields, '11111901'); 
                // PADRONIZADO: **Negrito**
                response = 'Aguarde um momento, por favor. Encaminhando sua conversa para um de nossos atendentes. 📞 \n\n*Por favor, descreva brevemente sua demanda para que o atendente possa ajudá-lo(a) melhor.* (Digite *menu* ou *voltar* para cancelar).';
                break;
                
            default:
                response = 'Opção inválida. ❓ Por favor, digite *menu* ou *voltar* para ver as opções novamente.';
        }

    // ------------------------------------------------------------------
    // --- TRATAMENTO DOS FLUXOS EM ANDAMENTO (ENTRADA TEXTUAL) ---
    // ------------------------------------------------------------------
    
    // --- Fluxo de Denúncia (Opção 1) ---
    } else if (currentState === 'denuncia_tipo') {
        let tipo = '';
        let tipoExtenso = '';

        if (numericBody === '1') { tipo = 'lote_sujo'; tipoExtenso = 'Lote Sujo'; } 
        else if (numericBody === '2') { tipo = 'empresa'; tipoExtenso = 'Empresa (Posturas)'; } 
        else if (numericBody === '3') { tipo = 'ocupacao_irregular'; tipoExtenso = 'Ocupação Irregular da Via'; }

        if (tipo === 'ocupacao_irregular') {
            const generatedProtocol = generateProtocolNumber(tipo);
            
            const fields = [
                { name: "Protocolo", value: generatedProtocol, inline: true },
                { name: "Tipo", value: tipoExtenso, inline: true },
                { name: "Ação", value: "Usuário redirecionado para Formulário Oficial", inline: false },
                { name: "Contato", value: to, inline: false },
            ];
            await sendToDiscord(`🚨 NOVA DENÚNCIA: ${tipoExtenso.toUpperCase()}`, fields, '16711680'); 

            userStates[userId] = null; 
            // PADRONIZADO: **Negrito**
            response = `Sua denúncia (Protocolo *${generatedProtocol}*) foi pré-registrada. ✅ Digite *menu* ou *voltar* para retornar.`;
        } else if (tipo === 'lote_sujo') {
            userStates[userId] = { type: tipo, step: 'denuncia_endereco' }; 
            // PADRONIZADO: **Negrito**
            response = `Você escolheu *${tipoExtenso}*. Por favor, envie o *Endereço Completo* do lote (Rua/Avenida, número, bairro, distrito e local de referência). 📍`;
        } else if (tipo === 'empresa') { // NOVO FLUXO: EMPRESA
            userStates[userId] = { type: tipo, step: 'denuncia_empresa_endereco' }; 
            // PADRONIZADO: **Negrito**
            response = `Você escolheu *${tipoExtenso}*. Por favor, envie o *Endereço Completo* da empresa (Rua/Avenida, número, bairro e local de referência). 📍`;
        } else {
            response = 'Opção inválida. ⚠️ Por favor, digite *1, 2 ou 3* ou *voltar* para ver as opções de denúncia.';
        }
        
    // CORREÇÃO DE SEGURANÇA: Checagem de nulo
    } else if (currentState && currentState.step === 'denuncia_endereco') {
        userStates[userId] = { ...currentState, endereco: messageBody, step: 'denuncia_fotos_pergunta' }; 
        // PADRONIZADO: **Negrito**
        response = `✅ Endereço registrado. 
Você deseja enviar *FOTOS* da ocorrência agora? (Máximo de 5 imagens)
*Digite SIM ou NÃO.*`; 

    // NOVO FLUXO: EMPRESA - ENDEREÇO
    } else if (currentState && currentState.step === 'denuncia_empresa_endereco') {
        userStates[userId] = { ...currentState, endereco: messageBody, step: 'denuncia_empresa_nome' };
        // PADRONIZADO: **Negrito**
        response = 'Endereço registrado. ✅ Agora, por favor, digite o *Nome da Empresa* denunciada. 🏢';

    // NOVO FLUXO: EMPRESA - NOME
    } else if (currentState && currentState.step === 'denuncia_empresa_nome') {
        userStates[userId] = { ...currentState, nomeEmpresa: messageBody, step: 'denuncia_empresa_motivo' };
        // PADRONIZADO: **Negrito**
        response = '✅ Nome da Empresa registrado. Por favor, *descreva o motivo da denúncia* (o que está irregular). Após descrever, *digite OK* para gerar o protocolo.';

    // NOVO FLUXO: EMPRESA - MOTIVO (GERA PROTOCOLO)
    } else if (currentState && currentState.step === 'denuncia_empresa_motivo') {
        if (messageBody === 'ok') {
            const generatedProtocol = generateProtocolNumber(currentState.type);
            
            const fields = [
                { name: "Protocolo", value: generatedProtocol, inline: true },
                { name: "Tipo", value: "Empresa (Posturas)", inline: true },
                { name: "Nome Empresa", value: currentState.nomeEmpresa || "Não fornecido", inline: false },
                { name: "Endereço", value: currentState.endereco || "Não fornecido", inline: false },
                { name: "Motivo da Denúncia", value: 'Recebido via Chatbot (Verificar histórico de mensagens)', inline: false },
                { name: "Contato", value: to, inline: false },
            ];
            await sendToDiscord("🚨 NOVA DENÚNCIA: EMPRESA (POSTURAS)", fields, '16711680'); 

            userStates[userId] = { step: 'satisfaction_survey', type: 'denuncia', protocol: generatedProtocol };
            // PADRONIZADO: **Negrito**
            response = `Obrigado! Recebemos sua denúncia. ✅ O seu número de *Protocolo é: ${generatedProtocol}*. Use este número na Opção 2 para acompanhamento.
            
*Para finalizar, por favor, avalie nosso atendimento. Digite uma nota de 1 (Ruim) a 5 (Excelente).* ⭐`;

        } else {
            // O usuário está digitando a descrição, apenas confirma o próximo passo.
            response = `Continue descrevendo ou, quando terminar, *digite OK* para gerar o protocolo.`;
            return;
        }

    // CORREÇÃO DE SEGURANÇA: Checagem de nulo (denuncia_fotos_pergunta - LOTE SUJO)
    } else if (currentState && currentState.step === 'denuncia_fotos_pergunta') {
        if (messageBody === 'sim') {
            userStates[userId].step = 'denuncia_recebendo_fotos';
            // PADRONIZADO: **Negrito**
            response = 'Certo! Por favor, envie as fotos (até 5) agora. 📸 Quando terminar de enviar, *digite OK* para prosseguir.';
        } else if (messageBody === 'não' || messageBody === 'nao') {
            const generatedProtocol = generateProtocolNumber(currentState.type);
            
            const fields = [
                { name: "Protocolo", value: generatedProtocol, inline: true },
                { name: "Tipo", value: "Lote Sujo", inline: true },
                { name: "Endereço", value: currentState.endereco || "Não fornecido", inline: false },
                { name: "Fotos", value: "Nenhuma foto enviada", inline: true },
                { name: "Contato", value: to, inline: false },
            ];
            await sendToDiscord("🚨 NOVA DENÚNCIA DE LOTE SUJO (SEM FOTOS)", fields, '16711680'); 

            userStates[userId] = { step: 'satisfaction_survey', type: 'denuncia', protocol: generatedProtocol };
            // PADRONIZADO: **Negrito**
            response = `Entendido. Sua denúncia foi PRÉ-REGISTRADA. ✅ O seu número de *Protocolo é: ${generatedProtocol}*. Use este número na Opção 2 para acompanhamento.

*Para finalizar, por favor, avalie nosso atendimento. Digite uma nota de 1 (Ruim) a 5 (Excelente).* ⭐`;
        } else {
            response = 'Resposta inválida. ❌ Por favor, digite *SIM* ou *NÃO*.\n\n(Digite *voltar* para retornar ao menu principal.)';
        }

    // CORREÇÃO DE SEGURANÇA: Checagem de nulo (denuncia_recebendo_fotos - LOTE SUJO)
    } else if (currentState && currentState.step === 'denuncia_recebendo_fotos') {
        if (messageBody === 'ok') {
            const generatedProtocol = generateProtocolNumber(currentState.type);
            
            // Nota: O tratamento das fotos (download/upload para um servidor de arquivos) deve ser adicionado aqui.
            // O código atual apenas registra no Discord que elas foram recebidas.
            
            const fields = [
                { name: "Protocolo", value: generatedProtocol, inline: true },
                { name: "Tipo", value: "Lote Sujo", inline: true },
                { name: "Endereço", value: currentState.endereco || "Não fornecido", inline: false },
                { name: "Fotos", value: "Recebidas via Chatbot (Verifique logs/servidor)", inline: false },
                { name: "Contato", value: to, inline: false },
            ];
            await sendToDiscord("🚨 NOVA DENÚNCIA DE LOTE SUJO (COM FOTOS)", fields, '16711680'); 

            userStates[userId] = { step: 'satisfaction_survey', type: 'denuncia', protocol: generatedProtocol };
            // PADRONIZADO: **Negrito**
            response = `Obrigado! Recebemos suas informações e fotos. ✅ O seu número de *Protocolo é: ${generatedProtocol}*. 
            
*Para finalizar, por favor, avalie nosso atendimento. Digite uma nota de 1 (Ruim) a 5 (Excelente).* ⭐`;
        } else {
            // Continua aguardando fotos ou a palavra 'ok'
            return; 
        }

    // --- Fluxo de Acompanhamento (Opção 2) ---
    } else if (currentState === 'acompanhamento_protocolo') {
        if (numericBody.match(/^\d{4}\.\d{2}\.\d{2}\.\d{1}\.\d{4}$/)) { 
            const protocol = numericBody.toUpperCase();
            
            const statusInfo = protocolDatabase[protocol];
            let currentStatus = 'Em Análise pelo Setor de Fiscalização'; 
            let additionalDetails = 'Solicite um atendente para mais informações.';
            
            if (statusInfo) {
                currentStatus = statusInfo.status;
                additionalDetails = statusInfo.details;
            }
            
            userStates[userId] = { step: 'satisfaction_survey', type: 'acompanhamento', protocol: protocol };
            // PADRONIZADO: **Negrito**. Status em *itálico* (formato `*status*`) é mantido intencionalmente para contraste.
            response = `Protocolo *${protocol}* encontrado! ✅ Status atual: *${currentStatus}*. Detalhes: ${additionalDetails}. Para mais detalhes, acesse: [Link de Consulta do Protocolo].
            
*Para finalizar, por favor, avalie nosso atendimento. Digite uma nota de 1 (Ruim) a 5 (Excelente).* ⭐`;
        } else {
            userStates[userId] = null; 
            response = 'O formato do protocolo está incorreto. ❌ Por favor, digite no formato AAAA.MM.DD.T.NNNN (Ex: 2025.12.08.1.0001). Digite *menu* ou *voltar* para retornar.';
        }
        
    // --- Fluxo de Pesquisa de Satisfação ---
    } else if (currentState && currentState.step === 'satisfaction_survey') {
        const rating = parseInt(numericBody, 10);
        const validRatings = [1, 2, 3, 4, 5];

        if (validRatings.includes(rating)) {
            const feedbackColor = (rating <= 2) ? '16776960' : '65280'; 
            
            const fields = [
                { name: "Nota Atribuída", value: `**${rating} / 5**`, inline: true },
                { name: "Tipo de Fluxo", value: currentState.type || "Geral", inline: true },
                { name: "Protocolo Relacionado", value: currentState.protocol || "N/A", inline: false },
                { name: "Contato", value: to, inline: false },
            ];
            await sendToDiscord("📊 PESQUISA DE SATISFAÇÃO RECEBIDA", fields, feedbackColor); 

            userStates[userId] = null; 
            response = 'Agradecemos a sua avaliação! Seu feedback é muito importante para nós. 🙏 Digite *menu* ou *voltar* para retornar.';
        } else {
            response = 'Opção inválida. ❗ Por favor, digite uma nota de *1 (Ruim) a 5 (Excelente)*.';
        }

    // ------------------------------------------------------------------
    // --- Resposta Padrão / Handoff Automático ---
    // ------------------------------------------------------------------
    } else {
        if (messageBody.length > 0) { 
            
            let currentUnknownCount = 0;
            if (currentState && currentState.unknownCount !== undefined) {
                currentUnknownCount = currentState.unknownCount;
            } else if (currentState !== null) {
                response = 'Opção inválida para o fluxo atual. 🤷 Por favor, digite uma opção válida ou *menu* para sair.';
            }

            if (response === '') { 
                
                currentUnknownCount++;
                
                if (currentUnknownCount >= 3) {
                    
                    const fields = [
                        { name: "Prioridade", value: "**HANDOFF AUTOMÁTICO**", inline: false },
                        { name: "Usuário", value: nomeCidadao, inline: true },
                        { name: "Contato WhatsApp", value: to, inline: true },
                        { name: "Motivo", value: "O usuário excedeu 3 tentativas de entrada inválida no menu principal.", inline: false },
                    ];
                    await sendToDiscord("🟣 HANDOFF AUTOMÁTICO POR FALHA DE COMPREENSÃO", fields, '11111901'); 

                    userStates[userId] = null; 
                    // PADRONIZADO: **Negrito**
                    response = 'Desculpe, não consegui entender o que você precisa. 😥 Para garantir que você seja atendido(a) corretamente, estou encaminhando sua conversa para um de nossos atendentes. 🧑‍💻 \n\n*Por favor, descreva brevemente sua demanda para que o atendente possa ajudá-lo(a) melhor.* (Digite *menu* ou *voltar* para cancelar).';

                } else {
                    userStates[userId] = { unknownCount: currentUnknownCount }; 
                    response = `Desculpe, não entendi. 🤔 Você pode digitar *menu* ou *voltar* para ver as opções novamente? (Tentativa ${currentUnknownCount} de 3 antes do atendimento humano).`;
                }
            }
        }
    }

    // Envio de qualquer resposta
    if (response) {
        client.sendMessage(to, response);
    }
}

client.initialize();