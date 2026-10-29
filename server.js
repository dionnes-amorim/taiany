
'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// A chave privilegiada permanece exclusivamente no servidor.
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

function database(res) {
  if (!supabase) {
    res.status(503).json({
      ok: false,
      error: 'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.'
    });
    return null;
  }

  return supabase;
}

// Temporário: autenticação administrativa será implementada depois.
function admin(req, res, next) {
  next();
}

function route(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;

  const date = new Date(value + 'T12:00:00Z');

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value || '');
}

function timeToMinutes(value) {
  if (!validTime(value)) return null;

  const parts = value.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function normalizeTime(value) {
  return value && value.length === 5 ? value + ':00' : value;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value || '');
}

function cleanText(value, max = 200) {
  return typeof value === 'string'
    ? value.trim().slice(0, max)
    : '';
}

function sendDbError(res, message, error) {
  console.error('[SUPABASE]', error?.message || error);
  return res.status(500).json({ ok: false, error: message });
}

const STATUS = [
  'pendente',
  'confirmado',
  'concluido',
  'cancelado'
];

// -----------------------------------------------------------------------------
// SAÚDE DO SERVIDOR
// -----------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Taiany Trindade — Nail Designer',
    supabaseConfigured: Boolean(supabase)
  });
});

// -----------------------------------------------------------------------------
// SERVIÇOS PÚBLICOS
// -----------------------------------------------------------------------------

app.get('/api/servicos', route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('servicos')
    .select('id,nome,categoria,descricao,preco,duracao_minutos')
    .eq('ativo', true)
    .order('nome');

  if (error) {
    return sendDbError(res, 'Não foi possível carregar os serviços.', error);
  }

  res.json({ ok: true, data });
}));

// -----------------------------------------------------------------------------
// DISPONIBILIDADE PÚBLICA
// -----------------------------------------------------------------------------

app.get('/api/disponibilidade', route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('disponibilidade')
    .select('id,dia_semana,hora_inicio,hora_fim')
    .eq('ativo', true)
    .order('dia_semana')
    .order('hora_inicio');

  if (error) {
    return sendDbError(res, 'Não foi possível carregar a disponibilidade.', error);
  }

  res.json({ ok: true, data });
}));

// -----------------------------------------------------------------------------
// CONSULTA DE HORÁRIOS OCUPADOS E BLOQUEIOS
// -----------------------------------------------------------------------------

app.get('/api/horarios', route(async (req, res) => {
  const data = req.query.data;

  if (!validDate(data)) {
    return res.status(400).json({
      ok: false,
      error: 'Informe a data no formato AAAA-MM-DD.'
    });
  }

  const db = database(res);
  if (!db) return;

  const [agenda, bloqueios] = await Promise.all([
    db.from('agendamentos')
      .select('hora_inicio,hora_fim')
      .eq('data', data)
      .neq('status', 'cancelado'),

    db.from('bloqueios')
      .select('hora_inicio,hora_fim')
      .eq('data', data)
  ]);

  if (agenda.error) {
    return sendDbError(res, 'Não foi possível consultar os agendamentos.', agenda.error);
  }

  if (bloqueios.error) {
    return sendDbError(res, 'Não foi possível consultar os bloqueios.', bloqueios.error);
  }

  res.json({
    ok: true,
    data,
    ocupados: agenda.data || [],
    bloqueios: bloqueios.data || []
  });
}));

// -----------------------------------------------------------------------------
// NOVO AGENDAMENTO PÚBLICO
// -----------------------------------------------------------------------------

app.post('/api/agendamentos', route(async (req, res) => {
  const nome = cleanText(req.body?.nome_cliente, 120);
  const telefone = cleanText(req.body?.telefone_cliente, 30);
  const email = cleanText(req.body?.email, 160).toLowerCase();
  const servicoId = req.body?.servico_id;
  const data = req.body?.data;
  const horaInicio = req.body?.hora_inicio;
  const observacoes = cleanText(req.body?.observacoes, 1000);

  if (nome.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'Informe seu nome completo.'
    });
  }

  const telefoneLimpo = telefone.replace(/\D/g, '');

  if (telefoneLimpo.length < 10 || telefoneLimpo.length > 13) {
    return res.status(400).json({
      ok: false,
      error: 'Informe um telefone válido com DDD.'
    });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      ok: false,
      error: 'Informe um e-mail válido.'
    });
  }

  if (!validId(servicoId) || !validDate(data) || !validTime(horaInicio)) {
    return res.status(400).json({
      ok: false,
      error: 'Confira o serviço, a data e o horário escolhidos.'
    });
  }

  const db = database(res);
  if (!db) return;

  const hoje = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  if (data < hoje) {
    return res.status(400).json({
      ok: false,
      error: 'Não é possível agendar em uma data passada.'
    });
  }

  const { data: servico, error: erroServico } = await db
    .from('servicos')
    .select('id,nome,preco,duracao_minutos,ativo')
    .eq('id', servicoId)
    .eq('ativo', true)
    .maybeSingle();

  if (erroServico) {
    return sendDbError(res, 'Não foi possível validar o serviço.', erroServico);
  }

  if (!servico) {
    return res.status(400).json({
      ok: false,
      error: 'O serviço selecionado não está disponível.'
    });
  }

  const inicioMin = timeToMinutes(horaInicio);
  const duracao = Number(servico.duracao_minutos);
  const preco = Number(servico.preco);

  if (
    inicioMin === null ||
    !Number.isInteger(duracao) ||
    duracao <= 0 ||
    !Number.isFinite(preco) ||
    preco < 0
  ) {
    return res.status(500).json({
      ok: false,
      error: 'O serviço está com preço ou duração inválidos no cadastro.'
    });
  }

  const fimMin = inicioMin + duracao;

  if (fimMin > 1440) {
    return res.status(400).json({
      ok: false,
      error: 'O horário escolhido ultrapassa o fim do dia.'
    });
  }

  const horaFim =
    String(Math.floor(fimMin / 60)).padStart(2, '0') +
    ':' +
    String(fimMin % 60).padStart(2, '0');

  const diaSemana = new Date(data + 'T12:00:00').getDay();

  const [disponibilidades, agenda, bloqueios] = await Promise.all([
    db.from('disponibilidade')
      .select('hora_inicio,hora_fim')
      .eq('dia_semana', diaSemana)
      .eq('ativo', true),

    db.from('agendamentos')
      .select('hora_inicio,hora_fim')
      .eq('data', data)
      .neq('status', 'cancelado'),

    db.from('bloqueios')
      .select('hora_inicio,hora_fim')
      .eq('data', data)
  ]);

  if (disponibilidades.error) {
    return sendDbError(res, 'Não foi possível validar o expediente.', disponibilidades.error);
  }

  if (agenda.error) {
    return sendDbError(res, 'Não foi possível validar a agenda.', agenda.error);
  }

  if (bloqueios.error) {
    return sendDbError(res, 'Não foi possível validar os bloqueios.', bloqueios.error);
  }

  const dentroDoExpediente = (disponibilidades.data || []).some(item => {
    const abre = timeToMinutes(item.hora_inicio);
    const fecha = timeToMinutes(item.hora_fim);

    return abre !== null && fecha !== null &&
      inicioMin >= abre && fimMin <= fecha;
  });

  if (!dentroDoExpediente) {
    return res.status(409).json({
      ok: false,
      error: 'Esse horário está fora do expediente disponível.'
    });
  }

  const conflitoAgenda = (agenda.data || []).some(item => {
    const inicio = timeToMinutes(item.hora_inicio);
    const fim = timeToMinutes(item.hora_fim);

    return inicio !== null && fim !== null &&
      overlaps(inicioMin, fimMin, inicio, fim);
  });

  if (conflitoAgenda) {
    return res.status(409).json({
      ok: false,
      error: 'Esse horário acabou de ser ocupado. Escolha outro.'
    });
  }

  const conflitoBloqueio = (bloqueios.data || []).some(item => {
    const inicio = timeToMinutes(item.hora_inicio);
    const fim = timeToMinutes(item.hora_fim);

    return inicio !== null && fim !== null &&
      overlaps(inicioMin, fimMin, inicio, fim);
  });

  if (conflitoBloqueio) {
    return res.status(409).json({
      ok: false,
      error: 'Esse horário está bloqueado. Escolha outro.'
    });
  }

  let cliente = null;

  const buscaTelefone = await db
    .from('clientes_taiany')
    .select('id,nome,telefone,email')
    .eq('telefone', telefone)
    .limit(1)
    .maybeSingle();

  if (buscaTelefone.error) {
    return sendDbError(res, 'Não foi possível consultar o cadastro do cliente.', buscaTelefone.error);
  }

  cliente = buscaTelefone.data;

  if (!cliente && email) {
    const buscaEmail = await db
      .from('clientes_taiany')
      .select('id,nome,telefone,email')
      .eq('email', email)
      .limit(1)
      .maybeSingle();

    if (buscaEmail.error) {
      return sendDbError(res, 'Não foi possível consultar o cadastro do cliente.', buscaEmail.error);
    }

    cliente = buscaEmail.data;
  }

  if (!cliente) {
    const { data: clienteCriado, error: erroCliente } = await db
      .from('clientes_taiany')
      .insert({
        nome,
        telefone,
        email: email || null
      })
      .select('id,nome,telefone,email')
      .single();

    if (erroCliente) {
      return sendDbError(res, 'Não foi possível cadastrar o cliente.', erroCliente);
    }

    cliente = clienteCriado;
  }

  const novoAgendamento = {
    cliente_id: cliente.id,
    nome_cliente: nome,
    telefone_cliente: telefone,
    servico_id: servico.id,
    nome_servico: servico.nome,
    data,
    hora_inicio: normalizeTime(horaInicio),
    hora_fim: normalizeTime(horaFim),
    preco,
    status: 'pendente',
    observacoes: observacoes || null,
    origem: 'online'
  };

  const { data: agendamento, error: erroAgendamento } = await db
    .from('agendamentos')
    .insert(novoAgendamento)
    .select('id,nome_servico,data,hora_inicio,hora_fim,preco,status')
    .single();

  if (erroAgendamento) {
    return sendDbError(res, 'Não foi possível concluir o agendamento.', erroAgendamento);
  }

  return res.status(201).json({
    ok: true,
    message: 'Agendamento solicitado com sucesso!',
    data: agendamento
  });
}));

// -----------------------------------------------------------------------------
// AGENDAMENTOS ADMINISTRATIVOS
// -----------------------------------------------------------------------------

app.get('/api/admin/agendamentos', admin, route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  let query = db.from('agendamentos')
    .select('*')
    .order('data')
    .order('hora_inicio')
    .limit(500);

  if (req.query.data) {
    if (!validDate(req.query.data)) {
      return res.status(400).json({
        ok: false,
        error: 'Data inválida.'
      });
    }

    query = query.eq('data', req.query.data);
  }

  if (req.query.status) {
    const status = cleanText(req.query.status, 30);

    if (!STATUS.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: 'Status inválido.'
      });
    }

    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    return sendDbError(res, 'Não foi possível carregar a agenda.', error);
  }

  res.json({ ok: true, data });
}));

app.patch('/api/admin/agendamentos/:id/status', admin, route(async (req, res) => {
  if (!validId(req.params.id) || !STATUS.includes(req.body?.status)) {
    return res.status(400).json({
      ok: false,
      error: 'ID ou status inválido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('agendamentos')
    .update({ status: req.body.status })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível atualizar o agendamento.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Agendamento não encontrado.'
    });
  }

  res.json({ ok: true, data });
}));

app.delete('/api/admin/agendamentos/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'ID inválido.' });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('agendamentos')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível excluir o agendamento.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Agendamento não encontrado.'
    });
  }

  res.json({ ok: true });
}));

// -----------------------------------------------------------------------------
// CLIENTES
// -----------------------------------------------------------------------------

app.get('/api/admin/clientes', admin, route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('clientes_taiany')
    .select('*')
    .order('nome')
    .limit(1000);

  if (error) {
    return sendDbError(res, 'Não foi possível carregar os clientes.', error);
  }

  res.json({ ok: true, data });
}));

app.post('/api/admin/clientes', admin, route(async (req, res) => {
  const nome = cleanText(req.body?.nome, 120);
  const telefone = cleanText(req.body?.telefone, 30);
  const email = cleanText(req.body?.email, 160).toLowerCase();

  if (nome.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'Informe o nome do cliente.'
    });
  }

  if (telefone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({
      ok: false,
      error: 'Informe um telefone válido com DDD.'
    });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      ok: false,
      error: 'Informe um e-mail válido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('clientes_taiany')
    .insert({
      nome,
      telefone,
      email: email || null,
      data_nascimento: req.body?.data_nascimento || null,
      observacoes: cleanText(req.body?.observacoes, 1000) || null
    })
    .select()
    .single();

  if (error) {
    return sendDbError(res, 'Não foi possível cadastrar o cliente.', error);
  }

  res.status(201).json({ ok: true, data });
}));

app.patch('/api/admin/clientes/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'ID inválido.' });
  }

  const permitidos = [
    'nome',
    'telefone',
    'email',
    'data_nascimento',
    'observacoes'
  ];

  const atualizacao = {};

  for (const campo of permitidos) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, campo)) {
      atualizacao[campo] =
        campo === 'observacoes'
          ? cleanText(req.body[campo], 1000) || null
          : campo === 'nome'
            ? cleanText(req.body[campo], 120)
            : campo === 'telefone'
              ? cleanText(req.body[campo], 30)
              : campo === 'email'
                ? cleanText(req.body[campo], 160).toLowerCase() || null
                : req.body[campo] || null;
    }
  }

  if (!Object.keys(atualizacao).length) {
    return res.status(400).json({
      ok: false,
      error: 'Nenhum campo para atualizar.'
    });
  }

  if ('nome' in atualizacao && atualizacao.nome.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'O nome precisa ter pelo menos 2 caracteres.'
    });
  }

  if ('telefone' in atualizacao &&
      atualizacao.telefone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({
      ok: false,
      error: 'Informe um telefone válido com DDD.'
    });
  }

  if ('email' in atualizacao && atualizacao.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(atualizacao.email)) {
    return res.status(400).json({
      ok: false,
      error: 'Informe um e-mail válido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('clientes')
    .update(atualizacao)
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível atualizar o cliente.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Cliente não encontrado.'
    });
  }

  res.json({ ok: true, data });
}));

// -----------------------------------------------------------------------------
// SERVIÇOS
// -----------------------------------------------------------------------------

app.get('/api/admin/servicos', admin, route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('servicos')
    .select('*')
    .order('nome');

  if (error) {
    return sendDbError(res, 'Não foi possível carregar os serviços.', error);
  }

  res.json({ ok: true, data });
}));

app.post('/api/admin/servicos', admin, route(async (req, res) => {
  const nome = cleanText(req.body?.nome, 120);
  const preco = Number(req.body?.preco);
  const duracao = Number(req.body?.duracao_minutos);

  if (!nome || !Number.isFinite(preco) || preco < 0 ||
      !Number.isInteger(duracao) || duracao <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'Informe nome, preço e duração válidos.'
    });
  }

  const db = database(res);
  if (!db) return;

  const registro = {
    nome,
    categoria: cleanText(req.body?.categoria, 80) || null,
    descricao: cleanText(req.body?.descricao, 1000) || null,
    preco,
    duracao_minutos: duracao,
    ativo: req.body?.ativo !== false
  };

  const { data, error } = await db
    .from('servicos')
    .insert(registro)
    .select()
    .single();

  if (error) {
    return sendDbError(res, 'Não foi possível cadastrar o serviço.', error);
  }

  res.status(201).json({ ok: true, data });
}));

app.patch('/api/admin/servicos/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ ok: false, error: 'ID inválido.' });
  }

  const campos = [
    'nome',
    'categoria',
    'descricao',
    'preco',
    'duracao_minutos',
    'ativo'
  ];

  const atualizacao = {};

  for (const campo of campos) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, campo)) {
      atualizacao[campo] = req.body[campo];
    }
  }

  if (!Object.keys(atualizacao).length) {
    return res.status(400).json({
      ok: false,
      error: 'Nenhum campo para atualizar.'
    });
  }

  if ('nome' in atualizacao) {
    atualizacao.nome = cleanText(atualizacao.nome, 120);
  }

  if ('categoria' in atualizacao) {
    atualizacao.categoria = cleanText(atualizacao.categoria, 80) || null;
  }

  if ('descricao' in atualizacao) {
    atualizacao.descricao = cleanText(atualizacao.descricao, 1000) || null;
  }

  if ('preco' in atualizacao) {
    atualizacao.preco = Number(atualizacao.preco);
  }

  if ('duracao_minutos' in atualizacao) {
    atualizacao.duracao_minutos = Number(atualizacao.duracao_minutos);
  }

  if (('nome' in atualizacao && !atualizacao.nome) ||
      ('preco' in atualizacao &&
        (!Number.isFinite(atualizacao.preco) || atualizacao.preco < 0)) ||
      ('duracao_minutos' in atualizacao &&
        (!Number.isInteger(atualizacao.duracao_minutos) ||
         atualizacao.duracao_minutos <= 0)) ||
      ('ativo' in atualizacao &&
        typeof atualizacao.ativo !== 'boolean')) {
    return res.status(400).json({
      ok: false,
      error: 'Dados do serviço inválidos.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('servicos')
    .update(atualizacao)
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível atualizar o serviço.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Serviço não encontrado.'
    });
  }

  res.json({ ok: true, data });
}));

app.delete('/api/admin/servicos/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: 'ID inválido.'
    });
  }

  const db = database(res);
  if (!db) return;

  // Desativa o serviço para preservar o histórico de agendamentos.
  const { data, error } = await db
    .from('servicos')
    .update({ ativo: false })
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível desativar o serviço.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Serviço não encontrado.'
    });
  }

  res.json({ ok: true });
}));

// -----------------------------------------------------------------------------
// DISPONIBILIDADE
// -----------------------------------------------------------------------------

app.get('/api/admin/disponibilidade', admin, route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('disponibilidade')
    .select('*')
    .order('dia_semana')
    .order('hora_inicio');

  if (error) {
    return sendDbError(res, 'Não foi possível carregar a disponibilidade.', error);
  }

  res.json({ ok: true, data });
}));

app.post('/api/admin/disponibilidade', admin, route(async (req, res) => {
  const dia = Number(req.body?.dia_semana);
  const inicio = req.body?.hora_inicio;
  const fim = req.body?.hora_fim;

  if (!Number.isInteger(dia) || dia < 0 || dia > 6 ||
      !validTime(inicio) || !validTime(fim) ||
      timeToMinutes(inicio) >= timeToMinutes(fim)) {
    return res.status(400).json({
      ok: false,
      error: 'Dia ou horário inválido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('disponibilidade')
    .insert({
      dia_semana: dia,
      hora_inicio: normalizeTime(inicio),
      hora_fim: normalizeTime(fim),
      ativo: req.body?.ativo !== false
    })
    .select()
    .single();

  if (error) {
    return sendDbError(res, 'Não foi possível cadastrar a disponibilidade.', error);
  }

  res.status(201).json({ ok: true, data });
}));

app.patch('/api/admin/disponibilidade/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: 'ID inválido.'
    });
  }

  const corpo = req.body || {};
  const atualizacao = {};

  if ('dia_semana' in corpo) atualizacao.dia_semana = Number(corpo.dia_semana);
  if ('hora_inicio' in corpo) atualizacao.hora_inicio = normalizeTime(corpo.hora_inicio);
  if ('hora_fim' in corpo) atualizacao.hora_fim = normalizeTime(corpo.hora_fim);
  if ('ativo' in corpo) atualizacao.ativo = corpo.ativo;

  if (!Object.keys(atualizacao).length) {
    return res.status(400).json({
      ok: false,
      error: 'Nenhum campo para atualizar.'
    });
  }

  if ('dia_semana' in atualizacao &&
      (!Number.isInteger(atualizacao.dia_semana) ||
       atualizacao.dia_semana < 0 || atualizacao.dia_semana > 6)) {
    return res.status(400).json({
      ok: false,
      error: 'Dia da semana inválido.'
    });
  }

  if (('hora_inicio' in atualizacao && !validTime(atualizacao.hora_inicio)) ||
      ('hora_fim' in atualizacao && !validTime(atualizacao.hora_fim)) ||
      ('ativo' in atualizacao && typeof atualizacao.ativo !== 'boolean')) {
    return res.status(400).json({
      ok: false,
      error: 'Dados de disponibilidade inválidos.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data: atual, error: erroAtual } = await db
    .from('disponibilidade')
    .select('hora_inicio,hora_fim')
    .eq('id', req.params.id)
    .maybeSingle();

  if (erroAtual) {
    return sendDbError(res, 'Não foi possível consultar a disponibilidade.', erroAtual);
  }

  if (!atual) {
    return res.status(404).json({
      ok: false,
      error: 'Disponibilidade não encontrada.'
    });
  }

  const inicio = atualizacao.hora_inicio || atual.hora_inicio;
  const fim = atualizacao.hora_fim || atual.hora_fim;

  if (timeToMinutes(inicio) === null ||
      timeToMinutes(fim) === null ||
      timeToMinutes(inicio) >= timeToMinutes(fim)) {
    return res.status(400).json({
      ok: false,
      error: 'O horário final deve ser posterior ao inicial.'
    });
  }

  const { data, error } = await db
    .from('disponibilidade')
    .update(atualizacao)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    return sendDbError(res, 'Não foi possível atualizar a disponibilidade.', error);
  }

  res.json({ ok: true, data });
}));

app.delete('/api/admin/disponibilidade/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: 'ID inválido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('disponibilidade')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível excluir a disponibilidade.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Disponibilidade não encontrada.'
    });
  }

  res.json({ ok: true });
}));

// -----------------------------------------------------------------------------
// BLOQUEIOS
// -----------------------------------------------------------------------------

app.get('/api/admin/bloqueios', admin, route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('bloqueios')
    .select('*')
    .order('data')
    .order('hora_inicio')
    .limit(1000);

  if (error) {
    return sendDbError(res, 'Não foi possível carregar os bloqueios.', error);
  }

  res.json({ ok: true, data });
}));

app.post('/api/admin/bloqueios', admin, route(async (req, res) => {
  const dataBloqueio = req.body?.data;
  const inicio = req.body?.hora_inicio;
  const fim = req.body?.hora_fim;

  if (!validDate(dataBloqueio) || !validTime(inicio) ||
      !validTime(fim) ||
      timeToMinutes(inicio) >= timeToMinutes(fim)) {
    return res.status(400).json({
      ok: false,
      error: 'Data ou horário de bloqueio inválido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('bloqueios')
    .insert({
      data: dataBloqueio,
      hora_inicio: normalizeTime(inicio),
      hora_fim: normalizeTime(fim),
      motivo: cleanText(req.body?.motivo, 300) || null
    })
    .select()
    .single();

  if (error) {
    return sendDbError(res, 'Não foi possível cadastrar o bloqueio.', error);
  }

  res.status(201).json({ ok: true, data });
}));

app.patch('/api/admin/bloqueios/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: 'ID inválido.'
    });
  }

  const corpo = req.body || {};
  const atualizacao = {};

  if ('data' in corpo) atualizacao.data = corpo.data;
  if ('hora_inicio' in corpo) atualizacao.hora_inicio = normalizeTime(corpo.hora_inicio);
  if ('hora_fim' in corpo) atualizacao.hora_fim = normalizeTime(corpo.hora_fim);
  if ('motivo' in corpo) atualizacao.motivo = cleanText(corpo.motivo, 300) || null;

  if (!Object.keys(atualizacao).length) {
    return res.status(400).json({
      ok: false,
      error: 'Nenhum campo para atualizar.'
    });
  }

  if (('data' in atualizacao && !validDate(atualizacao.data)) ||
      ('hora_inicio' in atualizacao && !validTime(atualizacao.hora_inicio)) ||
      ('hora_fim' in atualizacao && !validTime(atualizacao.hora_fim))) {
    return res.status(400).json({
      ok: false,
      error: 'Dados do bloqueio inválidos.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data: atual, error: erroAtual } = await db
    .from('bloqueios')
    .select('hora_inicio,hora_fim')
    .eq('id', req.params.id)
    .maybeSingle();

  if (erroAtual) {
    return sendDbError(res, 'Não foi possível consultar o bloqueio.', erroAtual);
  }

  if (!atual) {
    return res.status(404).json({
      ok: false,
      error: 'Bloqueio não encontrado.'
    });
  }

  const inicio = atualizacao.hora_inicio || atual.hora_inicio;
  const fim = atualizacao.hora_fim || atual.hora_fim;

  if (timeToMinutes(inicio) === null ||
      timeToMinutes(fim) === null ||
      timeToMinutes(inicio) >= timeToMinutes(fim)) {
    return res.status(400).json({
      ok: false,
      error: 'O horário final deve ser posterior ao inicial.'
    });
  }

  const { data, error } = await db
    .from('bloqueios')
    .update(atualizacao)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    return sendDbError(res, 'Não foi possível atualizar o bloqueio.', error);
  }

  res.json({ ok: true, data });
}));

app.delete('/api/admin/bloqueios/:id', admin, route(async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: 'ID inválido.'
    });
  }

  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('bloqueios')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();

  if (error) {
    return sendDbError(res, 'Não foi possível excluir o bloqueio.', error);
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Bloqueio não encontrado.'
    });
  }

  res.json({ ok: true });
}));

// -----------------------------------------------------------------------------
// ARQUIVOS ESTÁTICOS E PÁGINA INICIAL
// -----------------------------------------------------------------------------

app.use(express.static(path.join(__dirname), {
  index: false,
  dotfiles: 'deny'
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'taiany-painel-admin.html'));
});

app.get('/agendar', (req, res) => {
  res.sendFile(path.join(__dirname, 'taiany-agendamento.html'));
});
// se seu arquivo se chama agendamento.html, ajusta o nome aqui

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Rota não encontrada.'
  });
});

app.use((err, req, res, next) => {
  console.error('[ERRO]', err.message);

  if (res.headersSent) return next(err);

  res.status(500).json({
    ok: false,
    error: 'Erro interno do servidor.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Servidor Taiany iniciado na porta ' + PORT);
  console.log('Supabase: ' + (supabase ? 'configurado' : 'não configurado'));
});
