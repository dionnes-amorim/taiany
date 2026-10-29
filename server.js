
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ======================================================
// SESSÃO
// ======================================================

const sessionSecret = process.env.SESSION_SECRET;

if (IS_PRODUCTION && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error(
    'Configure SESSION_SECRET com pelo menos 32 caracteres no Render.'
  );
}

if (!sessionSecret) {
  console.warn('SESSION_SECRET ausente. Chave temporária apenas para desenvolvimento.');
}

app.use(session({
  name: 'taiany.sid',
  secret: sessionSecret || randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// ======================================================
// SUPABASE
// ======================================================

// A chave SERVICE_ROLE fica exclusivamente no servidor.
// Nunca a coloque em HTML, JavaScript do navegador ou GitHub.

let supabase = null;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  } catch (error) {
    console.error('Erro ao inicializar Supabase:', error.message);
  }
} else {
  console.error(
    'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.'
  );
}

function db() {
  if (!supabase) {
    const error = new Error(
      'Supabase indisponível. Confira as variáveis de ambiente do Render.'
    );
    error.status = 503;
    throw error;
  }

  return supabase;
}

// ======================================================
// CLIENTE PÚBLICO - WHATSAPP É O ID
// ======================================================

// VERIFICAR SE CLIENTE JÁ EXISTE PELO WHATSAPP
app.get('/api/cliente', async (req, res) => {
  try {
    const telefone = cleanText(req.query.telefone, 20).replace(/\D/g,'');
    if(!telefone || telefone.length < 10){
      return res.status(400).json({ok:false, error:'Informe um WhatsApp válido.'});
    }
    const { data, error } = await db().from('clientes_taiany').select('*').ilike('telefone', `%${telefone}%`).maybeSingle();
    if(error) throw error;
    if(!data){
      return res.json({ok:true, existe:false});
    }
    return res.json({ok:true, existe:true, data});
  } catch (e){ return sendDbError(res,e); }
});

// CADASTRAR CLIENTE PÚBLICO - WHATSAPP É ÚNICO
app.post('/api/clientes', async (req, res) => {
  try {
    const nome = cleanText(req.body?.nome, 150);
    const telefone = cleanText(req.body?.telefone, 20).replace(/\D/g,'');
    const email = cleanText(req.body?.email, 200);
    if(!nome || !telefone){
      return res.status(400).json({ok:false, error:'Nome e WhatsApp são obrigatórios.'});
    }
    // Verifica se já existe
    const { data: existe } = await db().from('clientes_taiany').select('id').ilike('telefone', `%${telefone}%`).maybeSingle();
    if(existe){
      return res.status(409).json({ok:false, error:'Já existe cadastro com esse WhatsApp. Faça login.'});
    }
    const { data, error } = await db().from('clientes_taiany').insert({nome, telefone, email}).select().single();
    if(error) throw error;
    return res.status(201).json({ok:true, data});
  } catch (e){ return sendDbError(res,e); }
});

// MEUS AGENDAMENTOS POR WHATSAPP
app.get('/api/meus-agendamentos', async (req, res) => {
  try {
    const telefone = cleanText(req.query.telefone, 20).replace(/\D/g,'');
    if(!telefone) return res.status(400).json({ok:false, error:'Informe o telefone.'});
    const { data, error } = await db().from('agendamentos').select('*').ilike('telefone_cliente', `%${telefone}%`).order('data',{ascending:false}).order('hora_inicio',{ascending:true});
    if(error) throw error;
    return res.json({ok:true, data});
  } catch (e){ return sendDbError(res,e); }
});

// ======================================================
// RESPOSTAS E VALIDAÇÕES
// ======================================================

function cleanText(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function validId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validClienteId(value) {
  const id = String(value ?? '').trim();
  return Boolean(id) && (validId(id) || /^\d+$/.test(id));
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);

  return date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d;
}

function validTime(value) {
  return typeof value === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
}

function normalizeTime(value) {
  if (!validTime(value)) return null;
  return value.length === 5 ? `${value}:00` : value;
}

function timeToMinutes(value) {
  if (!validTime(value)) return NaN;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}:00`;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function isCancelled(status) {
  return ['cancelado', 'cancelada', 'cancelled'].includes(
    String(status || '').trim().toLowerCase()
  );
}

function sendDbError(res, error) {
  console.error('[API/SUPABASE]', {
    message: error?.message,
    code: error?.code,
    details: error?.details,
    hint: error?.hint,
    status: error?.status
  });

  if (res.headersSent) return;

  const code = String(error?.code || '');

  if (error?.status === 503) {
    return res.status(503).json({ ok: false, error: error.message });
  }

  if (code === '23503') {
    return res.status(409).json({
      ok: false,
      code,
      error: 'Este registro possui vínculos com outros registros. Verifique as chaves estrangeiras antes de excluí-lo.'
    });
  }

  if (code === '23505') {
    return res.status(409).json({
      ok: false,
      code,
      error: 'Já existe um registro com esses dados.'
    });
  }

  if (code === '22P02' || code === '22007' || code === '22008') {
    return res.status(400).json({
      ok: false,
      code,
      error: 'Um dos dados enviados possui formato inválido.'
    });
  }

  if (code === '42501') {
    return res.status(403).json({
      ok: false,
      code,
      error: 'O Supabase recusou a operação por permissão ou política de segurança. Confira a chave usada pelo servidor.'
    });
  }

  if (code === '42P01' || code === 'PGRST205') {
    return res.status(500).json({
      ok: false,
      code,
      error: 'A tabela solicitada não foi encontrada no banco. Confira o nome da tabela e o schema.'
    });
  }

  if (code === '42703' || code === 'PGRST204') {
    return res.status(400).json({
      ok: false,
      code,
      error: 'A operação utiliza uma coluna que não existe na tabela. Confira os nomes das colunas no Supabase.'
    });
  }

  if (code === 'PGRST116') {
    return res.status(404).json({
      ok: false,
      code,
      error: 'Registro não encontrado.'
    });
  }

  return res.status(500).json({
    ok: false,
    code: code || undefined,
    error: 'Não foi possível concluir a operação. Confira os logs do Render.'
  });
}

async function executeQuery(res, query) {
  try {
    const { data, error } = await query;
    if (error) return sendDbError(res, error);
    return res.json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
}

function requireAuth(req, res, next) {
  if (req.session?.auth === true) return next();
  return res.redirect('/');
}

function admin(req, res, next) {
  if (req.session?.auth === true) return next();

  return res.status(401).json({
    ok: false,
    error: 'Sessão expirada ou acesso não autorizado. Faça login novamente.'
  });
}

function validRange(start, end) {
  const a = timeToMinutes(start);
  const b = timeToMinutes(end);
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

function getServiceDuration(service) {
  const duration = Number(service?.duracao_minutos ?? service?.duracao ?? 60);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function weekdayFromDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day, 12).getDay();
}

// ======================================================
// LOGIN, SESSÃO E LOGOUT
// ======================================================

app.post('/api/login', (req, res) => {
  const user = cleanText(req.body?.user, 100);
  const pass = String(req.body?.pass ?? '');
  const configuredUser = process.env.AUTH_USER;
  const configuredPass = process.env.AUTH_PASS;

  if (!configuredUser || !configuredPass) {
    return res.status(503).json({
      ok: false,
      error: 'Configure AUTH_USER e AUTH_PASS no Render.'
    });
  }

  if (user !== configuredUser || pass !== configuredPass) {
    return res.status(401).json({
      ok: false,
      error: 'Usuário ou senha incorretos.'
    });
  }

  req.session.regenerate((error) => {
    if (error) {
      console.error('Erro ao criar sessão:', error);
      return res.status(500).json({
        ok: false,
        error: 'Não foi possível iniciar a sessão.'
      });
    }

    req.session.auth = true;

    req.session.save((saveError) => {
      if (saveError) {
        console.error('Erro ao salvar sessão:', saveError);
        return res.status(500).json({
          ok: false,
          error: 'Não foi possível salvar a sessão.'
        });
      }

      return res.json({
        ok: true,
        redirect: '/taiany-painel-admin.html'
      });
    });
  });
});

app.get('/api/sessao', (req, res) => {
  res.json({
    ok: true,
    autenticado: req.session?.auth === true
  });
});

app.post('/api/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });

  req.session.destroy((error) => {
    if (error) {
      console.error('Erro ao encerrar sessão:', error);
      return res.status(500).json({
        ok: false,
        error: 'Não foi possível encerrar a sessão.'
      });
    }

    res.clearCookie('taiany.sid', {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: 'lax',
      path: '/'
    });

    return res.json({ ok: true });
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Taiany Trindade — Nail Designer',
    supabaseConfigured: Boolean(supabase)
  });
});

// ======================================================
// SERVIÇOS PÚBLICOS
// ======================================================

app.get('/api/servicos', async (req, res) => {
  try {
    return await executeQuery(
      res,
      db().from('servicos').select('*').order('nome', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// DISPONIBILIDADE PÚBLICA
// ======================================================

app.get('/api/disponibilidade', async (req, res) => {
  try {
    let query = db()
      .from('disponibilidade')
      .select('*')
      .order('dia_semana', { ascending: true });

    if (req.query.dia !== undefined) {
      const day = Number(req.query.dia);

      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return res.status(400).json({
          ok: false,
          error: 'Dia da semana inválido. Use um número de 0 a 6.'
        });
      }

      query = query.eq('dia_semana', day);
    }

    return await executeQuery(res, query);
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// FUNÇÃO COMPARTILHADA: LER DADOS DO AGENDAMENTO
// ======================================================

async function getBookingContext(date, serviceId) {
  const client = db();

  const { data: service, error: serviceError } = await client
    .from('servicos')
    .select('*')
    .eq('id', serviceId)
    .maybeSingle();

  if (serviceError) throw serviceError;
  if (!service) return { missingService: true };

  if (!parseBoolean(service.ativo, true)) {
    return { inactiveService: true };
  }

  const duration = getServiceDuration(service);
  if (!duration) return { invalidDuration: true };

  const weekday = weekdayFromDate(date);

  const [availability, blocks, bookings] = await Promise.all([
    client.from('disponibilidade')
      .select('*')
      .eq('dia_semana', weekday),

    client.from('bloqueios')
      .select('*')
      .eq('data', date),

    client.from('agendamentos')
      .select('*')
      .eq('data', date)
  ]);

  if (availability.error) throw availability.error;
  if (blocks.error) throw blocks.error;
  if (bookings.error) throw bookings.error;

  return {
    service,
    duration,
    availability: availability.data || [],
    blocks: blocks.data || [],
    bookings: bookings.data || []
  };
}

function isSlotAvailable(context, start, end) {
  const withinAvailability = context.availability.some((item) => {
    if (!parseBoolean(item.ativo, true)) return false;

    const open = timeToMinutes(item.hora_inicio);
    const close = timeToMinutes(item.hora_fim);

    return Number.isFinite(open) &&
      Number.isFinite(close) &&
      start >= open &&
      end <= close;
  });

  if (!withinAvailability) return false;

  const blocked = context.blocks.some((item) => {
    const a = timeToMinutes(item.hora_inicio);
    const b = timeToMinutes(item.hora_fim);

    return Number.isFinite(a) &&
      Number.isFinite(b) &&
      overlaps(start, end, a, b);
  });

  if (blocked) return false;

  const occupied = context.bookings.some((item) => {
    if (isCancelled(item.status)) return false;

    const a = timeToMinutes(item.hora_inicio);
    const b = timeToMinutes(item.hora_fim);

    return Number.isFinite(a) &&
      Number.isFinite(b) &&
      overlaps(start, end, a, b);
  });

  return !occupied;
}

// ======================================================
// HORÁRIOS DISPONÍVEIS
// ======================================================

app.get('/api/horarios', async (req, res) => {
  try {
    const date = cleanText(req.query.data, 10);
    const serviceId = cleanText(req.query.servico_id, 50);

    if (!validDate(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe uma data válida no formato AAAA-MM-DD.'
      });
    }

    if (!validId(serviceId)) {
      return res.status(400).json({
        ok: false,
        error: 'Selecione um serviço válido.'
      });
    }

    const context = await getBookingContext(date, serviceId);

    if (context.missingService) {
      return res.status(404).json({
        ok: false,
        error: 'Serviço não encontrado.'
      });
    }

    if (context.inactiveService) {
      return res.json({ ok: true, data: [] });
    }

    if (context.invalidDuration) {
      return res.status(400).json({
        ok: false,
        error: 'A duração do serviço está configurada incorretamente.'
      });
    }

    const slots = new Set();

    for (const range of context.availability) {
      if (!parseBoolean(range.ativo, true)) continue;

      const start = timeToMinutes(range.hora_inicio);
      const end = timeToMinutes(range.hora_fim);

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        continue;
      }

      for (
        let slot = start;
        slot + context.duration <= end;
        slot += 30
      ) {
        if (isSlotAvailable(context, slot, slot + context.duration)) {
          slots.add(minutesToTime(slot).slice(0, 5));
        }
      }
    }

    return res.json({
      ok: true,
      data: [...slots].sort()
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// CRIAR AGENDAMENTO PÚBLICO
// ======================================================

app.post('/api/agendamentos', async (req, res) => {
  try {
    const body = req.body || {};

    const nome = cleanText(body.nome_cliente || body.nome, 150);
    const telefone = cleanText(body.telefone_cliente || body.telefone, 40);
    const serviceId = cleanText(body.servico_id, 50);
    const date = cleanText(body.data, 10);
    const startTime = normalizeTime(body.hora_inicio || body.hora);
    const observations = cleanText(body.observacoes, 1000);

    if (!nome || !telefone || !serviceId || !date || !startTime) {
      return res.status(400).json({
        ok: false,
        error: 'Preencha nome, telefone, serviço, data e horário.'
      });
    }

    if (!validId(serviceId) || !validDate(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Serviço ou data inválidos.'
      });
    }

    const context = await getBookingContext(date, serviceId);

    if (context.missingService) {
      return res.status(404).json({
        ok: false,
        error: 'O serviço selecionado não foi encontrado.'
      });
    }

    if (context.inactiveService) {
      return res.status(409).json({
        ok: false,
        error: 'Este serviço não está disponível para agendamento.'
      });
    }

    if (context.invalidDuration) {
      return res.status(400).json({
        ok: false,
        error: 'A duração do serviço está configurada incorretamente.'
      });
    }

    const start = timeToMinutes(startTime);
    const end = start + context.duration;

    if (!Number.isFinite(start) || end > 1440) {
      return res.status(400).json({
        ok: false,
        error: 'Horário inválido ou fora do limite do dia.'
      });
    }

    if (!isSlotAvailable(context, start, end)) {
      return res.status(409).json({
        ok: false,
        error: 'Esse horário não está mais disponível. Atualize os horários e escolha outro.'
      });
    }

    const payload = {
      nome_cliente: nome,
      telefone_cliente: telefone,
      servico_id: context.service.id,
      nome_servico: context.service.nome,
      data: date,
      hora_inicio: startTime,
      hora_fim: minutesToTime(end),
      preco: Number(context.service.preco || 0),
      status: 'Pendente',
      observacoes,
      origem: 'site'
    };

    const { data, error } = await db()
      .from('agendamentos')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      data,
      message: 'Agendamento realizado com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// ADMIN — AGENDAMENTOS
// ======================================================

app.get('/api/admin/agendamentos', admin, async (req, res) => {
  try {
    let query = db()
      .from('agendamentos')
      .select('*')
      .order('data', { ascending: false })
      .order('hora_inicio', { ascending: true });

    if (req.query.data) {
      const date = String(req.query.data);

      if (!validDate(date)) {
        return res.status(400).json({
          ok: false,
          error: 'Data de filtro inválida.'
        });
      }

      query = query.eq('data', date);
    }

    if (req.query.status) {
      query = query.eq('status', cleanText(req.query.status, 50));
    }

    return await executeQuery(res, query);
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.patch('/api/admin/agendamentos/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de agendamento inválido.'
      });
    }

    const updates = {};

    if (req.body?.status !== undefined) {
      const status = cleanText(req.body.status, 50);
      if (!status) {
        return res.status(400).json({
          ok: false,
          error: 'O status não pode ficar vazio.'
        });
      }
      updates.status = status;
    }

    if (req.body?.observacoes !== undefined) {
      updates.observacoes = cleanText(req.body.observacoes, 1000);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        error: 'Nenhum campo válido foi enviado.'
      });
    }

    const { data, error } = await db()
      .from('agendamentos')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: 'Agendamento não encontrado.'
      });
    }

    return res.json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.delete('/api/admin/agendamentos/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de agendamento inválido.'
      });
    }

    const { data, error } = await db()
      .from('agendamentos')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        ok: false,
        error: 'Agendamento não encontrado ou não excluído.'
      });
    }

    return res.json({
      ok: true,
      data: data[0],
      message: 'Agendamento excluído com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// ADMIN — CLIENTES
// ======================================================

app.get('/api/admin/clientes', admin, async (req, res) => {
  try {
    return await executeQuery(
      res,
      db().from('clientes_taiany').select('*').order('nome', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/clientes', admin, async (req, res) => {
  try {
    const nome = cleanText(req.body?.nome, 150);
    const telefone = cleanText(req.body?.telefone, 40);
    const email = cleanText(req.body?.email, 200);

    if (!nome) {
      return res.status(400).json({
        ok: false,
        error: 'O nome do cliente é obrigatório.'
      });
    }

    const payload = { nome };
    if (telefone) payload.telefone = telefone;
    if (email) payload.email = email;

    const { data, error } = await db()
      .from('clientes_taiany')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      data,
      message: 'Cliente cadastrado com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.patch('/api/admin/clientes/:id', admin, async (req, res) => {
  try {
    const id = cleanText(req.params.id, 50);

    if (!validClienteId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de cliente inválido.'
      });
    }

    const updates = {};

    if (req.body?.nome !== undefined) {
      const nome = cleanText(req.body.nome, 150);
      if (!nome) {
        return res.status(400).json({
          ok: false,
          error: 'O nome do cliente não pode ficar vazio.'
        });
      }
      updates.nome = nome;
    }

    if (req.body?.telefone !== undefined) {
      updates.telefone = cleanText(req.body.telefone, 40);
    }

    if (req.body?.email !== undefined) {
      updates.email = cleanText(req.body.email, 200);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        error: 'Informe pelo menos um campo para atualizar.'
      });
    }

    const { data, error } = await db()
      .from('clientes_taiany')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: 'Cliente não encontrado.'
      });
    }

    return res.json({
      ok: true,
      data,
      message: 'Cliente atualizado com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// Exclusão definitiva: não declara sucesso sem confirmar a remoção.
// O ID é mantido como texto para não perder precisão em BIGINT.
app.delete('/api/admin/clientes/:id', admin, async (req, res) => {
  const id = cleanText(req.params.id, 50);

  try {
    console.log('[CLIENTE DELETE] Solicitação:', id);

    if (!validClienteId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de cliente inválido.'
      });
    }

    const client = db();

    const { data: cliente, error: findError } = await client
      .from('clientes_taiany')
      .select('id,nome')
      .eq('id', id)
      .maybeSingle();

    if (findError) throw findError;

    if (!cliente) {
      return res.status(404).json({
        ok: false,
        error: 'Cliente não encontrado. Atualize a lista e tente novamente.'
      });
    }

    const { data: deleted, error: deleteError } = await client
      .from('clientes_taiany')
      .delete()
      .eq('id', id)
      .select('id');

    if (deleteError) {
      console.error('[CLIENTE DELETE] Supabase:', deleteError);

      if (deleteError.code === '23503') {
        return res.status(409).json({
          ok: false,
          code: deleteError.code,
          error: 'A exclusão foi bloqueada porque existem registros vinculados a este cliente. É necessário corrigir a chave estrangeira ou definir uma regra de exclusão no banco.'
        });
      }

      throw deleteError;
    }

    if (!deleted?.length) {
      return res.status(409).json({
        ok: false,
        error: 'O Supabase não confirmou a exclusão. Confira as permissões e os vínculos do cliente.'
      });
    }

    console.log('[CLIENTE DELETE] Exclusão confirmada:', deleted[0].id);

    return res.json({
      ok: true,
      id: deleted[0].id,
      message: 'Cliente excluído com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// ADMIN — SERVIÇOS
// ======================================================

app.get('/api/admin/servicos', admin, async (req, res) => {
  try {
    return await executeQuery(
      res,
      db().from('servicos').select('*').order('nome', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/servicos', admin, async (req, res) => {
  try {
    const nome = cleanText(req.body?.nome, 150);
    const duration = Number(req.body?.duracao_minutos ?? req.body?.duracao ?? 60);
    const price = Number(req.body?.preco ?? 0);

    if (!nome) {
      return res.status(400).json({
        ok: false,
        error: 'O nome do serviço é obrigatório.'
      });
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Informe uma duração válida.'
      });
    }

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um preço válido.'
      });
    }

    const payload = {
      nome,
      descricao: cleanText(req.body?.descricao, 1000),
      duracao_minutos: duration,
      preco: price
    };

    if (req.body?.ativo !== undefined) {
      payload.ativo = parseBoolean(req.body.ativo);
    }

    const { data, error } = await db()
      .from('servicos')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.patch('/api/admin/servicos/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de serviço inválido.'
      });
    }

    const updates = {};

    if (req.body?.nome !== undefined) {
      const nome = cleanText(req.body.nome, 150);
      if (!nome) {
        return res.status(400).json({
          ok: false,
          error: 'O nome do serviço não pode ficar vazio.'
        });
      }
      updates.nome = nome;
    }

    if (req.body?.descricao !== undefined) {
      updates.descricao = cleanText(req.body.descricao, 1000);
    }

    if (req.body?.duracao_minutos !== undefined || req.body?.duracao !== undefined) {
      const duration = Number(req.body.duracao_minutos ?? req.body.duracao);
      if (!Number.isFinite(duration) || duration <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Duração inválida.'
        });
      }
      updates.duracao_minutos = duration;
    }

    if (req.body?.preco !== undefined) {
      const price = Number(req.body.preco);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          ok: false,
          error: 'Preço inválido.'
        });
      }
      updates.preco = price;
    }

    if (req.body?.ativo !== undefined) {
      updates.ativo = parseBoolean(req.body.ativo);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        error: 'Nenhum campo válido foi enviado.'
      });
    }

    const { data, error } = await db()
      .from('servicos')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: 'Serviço não encontrado.'
      });
    }

    return res.json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.delete('/api/admin/servicos/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de serviço inválido.'
      });
    }

    const { data, error } = await db()
      .from('servicos')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        ok: false,
        error: 'Serviço não encontrado.'
      });
    }

    return res.json({
      ok: true,
      message: 'Serviço excluído com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// ADMIN — DISPONIBILIDADE
// ======================================================

app.get('/api/admin/disponibilidade', admin, async (req, res) => {
  try {
    return await executeQuery(
      res,
      db().from('disponibilidade').select('*').order('dia_semana', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/disponibilidade', admin, async (req, res) => {
  try {
    const day = Number(req.body?.dia_semana);
    const start = normalizeTime(req.body?.hora_inicio);
    const end = normalizeTime(req.body?.hora_fim);

    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return res.status(400).json({
        ok: false,
        error: 'Dia da semana inválido. Use de 0 a 6.'
      });
    }

    if (!start || !end || !validRange(start, end)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe horários válidos, com o fim depois do início.'
      });
    }

    const payload = {
      dia_semana: day,
      hora_inicio: start,
      hora_fim: end
    };

    if (req.body?.ativo !== undefined) {
      payload.ativo = parseBoolean(req.body.ativo);
    }

    const { data, error } = await db()
      .from('disponibilidade')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.patch('/api/admin/disponibilidade/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de disponibilidade inválido.'
      });
    }

    const updates = {};

    if (req.body?.dia_semana !== undefined) {
      const day = Number(req.body.dia_semana);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return res.status(400).json({
          ok: false,
          error: 'Dia da semana inválido.'
        });
      }
      updates.dia_semana = day;
    }

    for (const field of ['hora_inicio', 'hora_fim']) {
      if (req.body?.[field] !== undefined) {
        const time = normalizeTime(req.body[field]);
        if (!time) {
          return res.status(400).json({
            ok: false,
            error: `Horário inválido: ${field}.`
          });
        }
        updates[field] = time;
      }
    }

    if (req.body?.ativo !== undefined) {
      updates.ativo = parseBoolean(req.body.ativo);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        error: 'Nenhum campo válido foi enviado.'
      });
    }

    // Busca a faixa atual para validar o intervalo combinado.
    if (updates.hora_inicio || updates.hora_fim) {
      const { data: current, error: readError } = await db()
        .from('disponibilidade')
        .select('hora_inicio,hora_fim')
        .eq('id', id)
        .maybeSingle();

      if (readError) throw readError;

      if (!current) {
        return res.status(404).json({
          ok: false,
          error: 'Disponibilidade não encontrada.'
        });
      }

      const start = updates.hora_inicio || current.hora_inicio;
      const end = updates.hora_fim || current.hora_fim;

      if (!validRange(start, end)) {
        return res.status(400).json({
          ok: false,
          error: 'O horário final deve ser posterior ao horário inicial.'
        });
      }
    }

    const { data, error } = await db()
      .from('disponibilidade')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: 'Disponibilidade não encontrada.'
      });
    }

    return res.json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.delete('/api/admin/disponibilidade/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de disponibilidade inválido.'
      });
    }

    const { data, error } = await db()
      .from('disponibilidade')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        ok: false,
        error: 'Disponibilidade não encontrada.'
      });
    }

    return res.json({
      ok: true,
      message: 'Disponibilidade excluída com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// ADMIN — BLOQUEIOS
// ======================================================

app.get('/api/admin/bloqueios', admin, async (req, res) => {
  try {
    let query = db()
      .from('bloqueios')
      .select('*')
      .order('data', { ascending: true });

    if (req.query.data) {
      const date = String(req.query.data);

      if (!validDate(date)) {
        return res.status(400).json({
          ok: false,
          error: 'Data de filtro inválida.'
        });
      }

      query = query.eq('data', date);
    }

    return await executeQuery(res, query);
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/bloqueios', admin, async (req, res) => {
  try {
    const date = cleanText(req.body?.data, 10);
    const start = normalizeTime(req.body?.hora_inicio);
    const end = normalizeTime(req.body?.hora_fim);
    const reason = cleanText(req.body?.motivo, 500);

    if (!validDate(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe uma data válida.'
      });
    }

    if (!start || !end || !validRange(start, end)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um intervalo de horários válido.'
      });
    }

    const { data, error } = await db()
      .from('bloqueios')
      .insert({
        data: date,
        hora_inicio: start,
        hora_fim: end,
        motivo: reason
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.delete('/api/admin/bloqueios/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de bloqueio inválido.'
      });
    }

    const { data, error } = await db()
      .from('bloqueios')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw error;

    if (!data?.length) {
      return res.status(404).json({
        ok: false,
        error: 'Bloqueio não encontrado.'
      });
    }

    return res.json({
      ok: true,
      message: 'Bloqueio excluído com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// PÁGINAS
// ======================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/taiany-painel-admin.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'taiany-painel-admin.html'));
});

app.get('/taiany-agendamento.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'taiany-agendamento.html'));
});

app.get('/agendar', (req, res) => {
  res.sendFile(path.join(__dirname, 'taiany-agendamento.html'));
});

// Bloqueia arquivos de configuração e código do servidor.
app.use((req, res, next) => {
  const requested = decodeURIComponent(req.path || '/');
  const forbidden = [
    /^\/server\.js$/i,
    /^\/package(?:-lock)?\.json$/i,
    /^\/\.env(?:\..*)?$/i,
    /^\/\.git(?:\/|$)/i,
    /^\/node_modules(?:\/|$)/i
  ];

  if (forbidden.some((pattern) => pattern.test(requested))) {
    return res.status(404).end();
  }

  return next();
});

// Mantém a estrutura atual do projeto.
// Idealmente, mova os arquivos públicos para uma pasta "public".
app.use(express.static(__dirname, {
  index: false,
  dotfiles: 'deny'
}));

// ======================================================
// ROTAS NÃO ENCONTRADAS E ERROS
// ======================================================

app.use((req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'Rota não encontrada.'
  });
});

app.use((error, req, res, next) => {
  console.error('[ERRO NÃO TRATADO]', error);

  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      ok: false,
      error: 'O corpo da requisição contém JSON inválido.'
    });
  }

  return res.status(500).json({
    ok: false,
    error: 'Erro interno do servidor.'
  });
});

// ======================================================
// INICIALIZAÇÃO
// ======================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log(`Ambiente: ${IS_PRODUCTION ? 'produção' : 'desenvolvimento'}`);
  console.log(`Supabase configurado: ${Boolean(supabase)}`);
});
