
'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const { SUPABASE_URL, SUPABASE_KEY } = process.env;

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
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
      error: 'Configure SUPABASE_URL e SUPABASE_KEY no Render.'
    });
    return null;
  }
  return supabase;
}

function admin(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN;
  const supplied = req.get('x-admin-token') || '';

  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: 'Configure ADMIN_API_TOKEN no Render.'
    });
  }

  const crypto = require('crypto');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      ok: false,
      error: 'Acesso administrativo não autorizado.'
    });
  }

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

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Taiany Trindade — Nail Designer',
    supabaseConfigured: Boolean(supabase)
  });
});

app.get('/api/servicos', route(async (req, res) => {
  const db = database(res);
  if (!db) return;

  const { data, error } = await db
    .from('servicos')
    .select('id,nome,categoria,descricao,preco,duracao_minutos')
    .eq('ativo', true)
    .order('nome');

  if (error) {
    console.error(error.message);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível carregar os serviços.'
    });
  }

  res.json({ ok: true, data });
}));

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
    console.error(error.message);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível carregar a disponibilidade.'
    });
  }

  res.json({ ok: true, data });
}));

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

  if (agenda.error || bloqueios.error) {
    console.error(agenda.error || bloqueios.error);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível consultar os horários.'
    });
  }

  res.json({
    ok: true,
    data,
    ocupados: agenda.data,
    bloqueios: bloqueios.data
  });
}));

// Rotas administrativas protegidas por token.
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

  const { data, error } = await query;

  if (error) {
    console.error(error.message);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível carregar a agenda.'
    });
  }

  res.json({ ok: true, data });
}));

app.patch('/api/admin/agendamentos/:id/status', admin, route(async (req, res) => {
  const permitidos = [
    'pendente', 'confirmado', 'concluido', 'cancelado'
  ];

  if (!permitidos.includes(req.body?.status)) {
    return res.status(400).json({
      ok: false,
      error: 'Status inválido.'
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
    console.error(error.message);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível atualizar o agendamento.'
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: 'Agendamento não encontrado.'
    });
  }

  res.json({ ok: true, data });
}));

app.use(express.static(path.join(__dirname), {
  index: false,
  dotfiles: 'deny'
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'taiany-painel-admin.html'));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Rota não encontrada.' });
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
