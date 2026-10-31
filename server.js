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
  console.warn(
    'SESSION_SECRET ausente. Chave temporária apenas para desenvolvimento.'
  );
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

let supabase = null;

if (
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
) {
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
// FUNÇÕES GERAIS
// ======================================================

function cleanText(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

// Salva e compara telefones apenas com números.
// Exemplo: (17) 99999-9999 -> 17999999999.
function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function validPhone(value) {
  const phone = normalizePhone(value);
  return phone.length >= 10 && phone.length <= 15;
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
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return value === true || value === 'true' || value === 1 || value === '1';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);

  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
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

  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  return (
    `${String(Math.floor(value / 60)).padStart(2, '0')}:` +
    `${String(value % 60).padStart(2, '0')}:00`
  );
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function isCancelled(status) {
  return ['cancelado', 'cancelada', 'cancelled'].includes(
    String(status || '').trim().toLowerCase()
  );
}

function validRange(start, end) {
  const a = timeToMinutes(start);
  const b = timeToMinutes(end);

  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

function getServiceDuration(service) {
  const duration = Number(
    service?.duracao_minutos ?? service?.duracao ?? 60
  );

  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function weekdayFromDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day, 12).getDay();
}

// Retorna a data e a hora atuais no fuso de São Paulo,
// independentemente do fuso configurado no servidor.
function getSaoPauloNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const value = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return {
    date: `${value.year}-${value.month}-${value.day}`,
    minutes: Number(value.hour) * 60 + Number(value.minute)
  };
}

function isPastSlot(date, startMinutes) {
  const now = getSaoPauloNow();

  if (date < now.date) return true;
  if (date > now.date) return false;

  // Não permite o horário atual nem qualquer horário anterior.
  return startMinutes <= now.minutes;
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
    return res.status(503).json({
      ok: false,
      error: error.message
    });
  }

  if (code === '23503') {
    return res.status(409).json({
      ok: false,
      code,
      error: 'Este registro possui vínculos com outros registros.'
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
      error: 'O Supabase recusou a operação por permissão ou política de segurança.'
    });
  }

  if (code === '42P01' || code === 'PGRST205') {
    return res.status(500).json({
      ok: false,
      code,
      error: 'A tabela solicitada não foi encontrada. Confira o nome da tabela.'
    });
  }

  if (code === '42703' || code === 'PGRST204') {
    return res.status(400).json({
      ok: false,
      code,
      error: 'A operação utiliza uma coluna que não existe na tabela.'
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

// ======================================================
// LOCK DE AGENDAMENTO
// ======================================================

// Evita que duas requisições simultâneas no mesmo processo do servidor
// reservem o mesmo intervalo antes da gravação.
// Para múltiplas instâncias do servidor, veja a observação após o código.
const bookingLocks = new Map();

async function withBookingLock(key, action) {
  const previous = bookingLocks.get(key) || Promise.resolve();

  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });

  bookingLocks.set(key, current);

  await previous;

  try {
    return await action();
  } finally {
    release();

    if (bookingLocks.get(key) === current) {
      bookingLocks.delete(key);
    }
  }
}

// ======================================================
// SESSÃO, LOGIN E LOGOUT
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

  req.session.regenerate(error => {
    if (error) {
      console.error('Erro ao criar sessão:', error);

      return res.status(500).json({
        ok: false,
        error: 'Não foi possível iniciar a sessão.'
      });
    }

    req.session.auth = true;

    req.session.save(saveError => {
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

  req.session.destroy(error => {
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


/**
 * CANCELAR AGENDAMENTO PELO WHATSAPP
 * Confere o telefone antes de alterar o registro.
 */
app.patch('/api/meus-agendamentos/:id/cancelar', async (req, res) => {
  try {
    const id = req.params.id;
    const telefone = normalizePhone(req.body?.telefone);

    if (!validId(id) || !validPhone(telefone)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um agendamento e um WhatsApp válidos.'
      });
    }

    const client = db();

    const { data: agendamento, error: findError } = await client
      .from('agendamentos')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (findError) throw findError;

    if (
      !agendamento ||
      normalizePhone(agendamento.telefone_cliente) !== telefone
    ) {
      return res.status(404).json({
        ok: false,
        error: 'Agendamento não encontrado para esse WhatsApp.'
      });
    }

    if (isCancelled(agendamento.status)) {
      return res.status(409).json({
        ok: false,
        error: 'Este agendamento já está cancelado.'
      });
    }

    const statusAtual = String(agendamento.status || '')
      .trim()
      .toLowerCase();

    if (
      ['concluído', 'concluido', 'concluída', 'concluida'].includes(statusAtual)
    ) {
      return res.status(409).json({
        ok: false,
        error: 'Não é possível cancelar um atendimento já concluído.'
      });
    }

    const { data, error } = await client
      .from('agendamentos')
      .update({ status: 'Cancelado' })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: 'Não foi possível localizar o agendamento para cancelar.'
      });
    }

    return res.json({
      ok: true,
      data,
      message: 'Agendamento cancelado com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});


/**
 * REMARCAR AGENDAMENTO PELO WHATSAPP
 * Confere o telefone, a data, o horário e a disponibilidade real.
 */
app.patch('/api/meus-agendamentos/:id/remarcar', async (req, res) => {
  try {
    const id = req.params.id;
    const telefone = normalizePhone(req.body?.telefone);
    const date = cleanText(req.body?.data, 10);
    const startTime = normalizeTime(req.body?.hora_inicio);

    if (
      !validId(id) ||
      !validPhone(telefone) ||
      !validDate(date) ||
      !startTime
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Informe o WhatsApp, uma data e um horário válidos.'
      });
    }

    const client = db();

    const { data: agendamento, error: findError } = await client
      .from('agendamentos')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (findError) throw findError;

    if (
      !agendamento ||
      normalizePhone(agendamento.telefone_cliente) !== telefone
    ) {
      return res.status(404).json({
        ok: false,
        error: 'Agendamento não encontrado para esse WhatsApp.'
      });
    }

    if (isCancelled(agendamento.status)) {
      return res.status(409).json({
        ok: false,
        error: 'Este agendamento está cancelado. Faça um novo agendamento.'
      });
    }

    const statusAtual = String(agendamento.status || '')
      .trim()
      .toLowerCase();

    if (
      ['concluído', 'concluido', 'concluída', 'concluida'].includes(statusAtual)
    ) {
      return res.status(409).json({
        ok: false,
        error: 'Não é possível remarcar um atendimento já concluído.'
      });
    }

    if (isPastSlot(date, timeToMinutes(startTime))) {
      return res.status(409).json({
        ok: false,
        error: 'Escolha uma data e um horário futuros.'
      });
    }

    return await withBookingLock(date, async () => {
      // Reconsulta o registro para evitar atualizar uma reserva já alterada.
      const { data: atual, error: atualError } = await client
        .from('agendamentos')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (atualError) throw atualError;

      if (
        !atual ||
        normalizePhone(atual.telefone_cliente) !== telefone
      ) {
        return res.status(404).json({
          ok: false,
          error: 'Agendamento não encontrado.'
        });
      }

      if (isCancelled(atual.status)) {
        return res.status(409).json({
          ok: false,
          error: 'Este agendamento foi cancelado e não pode ser remarcado.'
        });
      }

      const context = await getBookingContext(date, atual.servico_id);

      if (context.missingService || context.inactiveService) {
        return res.status(409).json({
          ok: false,
          error: 'O serviço deste agendamento não está disponível para remarcação.'
        });
      }

      if (context.invalidDuration) {
        return res.status(400).json({
          ok: false,
          error: 'A duração do serviço está configurada incorretamente.'
        });
      }

      // Ignora a própria reserva ao verificar conflitos de horário.
      context.bookings = context.bookings.filter(
        item => String(item.id) !== String(id)
      );

      const start = timeToMinutes(startTime);
      const end = start + context.duration;

      if (!Number.isFinite(start) || end > 1440) {
        return res.status(400).json({
          ok: false,
          error: 'Horário inválido.'
        });
      }

      if (isPastSlot(date, start)) {
        return res.status(409).json({
          ok: false,
          error: 'Esse horário já passou. Escolha outro.'
        });
      }

      if (!isSlotAvailable(context, start, end)) {
        return res.status(409).json({
          ok: false,
          code: 'HORARIO_INDISPONIVEL',
          error: 'Esse horário não está disponível. Escolha outro horário.'
        });
      }

      const { data, error } = await client
        .from('agendamentos')
        .update({
          data: date,
          hora_inicio: startTime,
          hora_fim: minutesToTime(end)
        })
        .eq('id', id)
        .select()
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({
          ok: false,
          error: 'Não foi possível atualizar o agendamento.'
        });
      }

      return res.json({
        ok: true,
        data,
        message: 'Agendamento remarcado com sucesso.'
      });
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});



// ======================================================
// CLIENTES PÚBLICOS
// ======================================================

// Busca clientes comparando os números normalizados.
// Evita correspondências incorretas causadas por buscas parciais.
async function findClientByPhone(phone) {
  const normalized = normalizePhone(phone);

  if (!validPhone(normalized)) return null;

  const { data, error } = await db()
    .from('clientes_taiany')
    .select('*');

  if (error) throw error;

  return (data || []).find(
    client => normalizePhone(client.telefone) === normalized
  ) || null;
}

// CONSULTAR CLIENTE PELO WHATSAPP
app.get('/api/cliente', async (req, res) => {
  try {
    const telefone = normalizePhone(req.query.telefone);

    if (!validPhone(telefone)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um WhatsApp válido com DDD.'
      });
    }

    const cliente = await findClientByPhone(telefone);

    if (!cliente) {
      return res.json({
        ok: true,
        existe: false
      });
    }

    return res.json({
      ok: true,
      existe: true,
      data: cliente
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// CADASTRAR CLIENTE PÚBLICO
app.post('/api/clientes', async (req, res) => {
  try {
    const nome = cleanText(req.body?.nome, 150);
    const telefone = normalizePhone(req.body?.telefone);
    const email = cleanText(req.body?.email, 200);

    if (!nome || !validPhone(telefone)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe seu nome e um WhatsApp válido com DDD.'
      });
    }

    const existente = await findClientByPhone(telefone);

    if (existente) {
      return res.status(409).json({
        ok: false,
        code: 'CLIENTE_EXISTENTE',
        error: 'Já existe cadastro com esse WhatsApp. Utilize seu cadastro existente.',
        data: existente
      });
    }

    const payload = {
      nome,
      telefone,
      email
    };

    const { data, error } = await db()
      .from('clientes_taiany')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      data,
      message: 'Cadastro realizado com sucesso.'
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// CONSULTAR AGENDAMENTOS PELO WHATSAPP
app.get('/api/meus-agendamentos', async (req, res) => {
  try {
    const telefone = normalizePhone(req.query.telefone);

    if (!validPhone(telefone)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um WhatsApp válido.'
      });
    }

    const { data, error } = await db()
      .from('agendamentos')
      .select('*')
      .order('data', { ascending: false })
      .order('hora_inicio', { ascending: true });

    if (error) throw error;

    const agendamentos = (data || []).filter(
      item => normalizePhone(item.telefone_cliente) === telefone
    );

    return res.json({
      ok: true,
      data: agendamentos
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// SERVIÇOS PÚBLICOS
// ======================================================

app.get('/api/servicos', async (req, res) => {
  try {
    return await executeQuery(
      res,
      db()
        .from('servicos')
        .select('*')
        .order('nome', { ascending: true })
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

      // dentro da query, depois do eq ativo:
      if(req.query.cidade) query = query.eq('cidade', req.query.cidade)

      query = query.eq('dia_semana', day);
    }

    return await executeQuery(res, query);
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// CONTEXTO DE AGENDAMENTO
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
    client
      .from('disponibilidade')
      .select('*')
      .eq('dia_semana', weekday),

    client
      .from('bloqueios')
      .select('*')
      .eq('data', date),

    client
      .from('agendamentos')
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
  const withinAvailability = context.availability.some(item => {
    if (!parseBoolean(item.ativo, true)) return false;

    const open = timeToMinutes(item.hora_inicio);
    const close = timeToMinutes(item.hora_fim);

    return Number.isFinite(open) &&
      Number.isFinite(close) &&
      start >= open &&
      end <= close;
  });

  if (!withinAvailability) return false;

  const blocked = context.blocks.some(item => {
    const startBlock = timeToMinutes(item.hora_inicio);
    const endBlock = timeToMinutes(item.hora_fim);

    return Number.isFinite(startBlock) &&
      Number.isFinite(endBlock) &&
      overlaps(start, end, startBlock, endBlock);
  });

  if (blocked) return false;

  const occupied = context.bookings.some(item => {
    if (isCancelled(item.status)) return false;

    const bookingStart = timeToMinutes(item.hora_inicio);
    const bookingEnd = timeToMinutes(item.hora_fim);

    return Number.isFinite(bookingStart) &&
      Number.isFinite(bookingEnd) &&
      overlaps(start, end, bookingStart, bookingEnd);
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

    if (date < getSaoPauloNow().date) {
      return res.json({
        ok: true,
        data: []
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
      return res.json({
        ok: true,
        data: []
      });
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

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      ) {
        continue;
      }

      for (
        let slot = start;
        slot + context.duration <= end;
        slot += 30
      ) {
        if (isPastSlot(date, slot)) continue;

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

app.get('/api/meus-agendamentos', async (req, res) => {
  try {
    const telefone = cleanText(req.query.telefone, 20).replace(/\D/g,'');
    const { data, error } = await db().from('agendamentos').select('*').ilike('telefone_cliente', `%${telefone}%`).order('data',{ascending:false});
    if(error) throw error;
    return res.json({ok:true, data});
  } catch (e){ return sendDbError(res,e); }
});

// ======================================================
// CRIAR AGENDAMENTO PÚBLICO
// ======================================================

app.post('/api/agendamentos', async (req, res) => {
  try {
    const body = req.body || {};

    const nome = cleanText(body.nome_cliente || body.nome, 150);
    const telefone = normalizePhone(
      body.telefone_cliente || body.telefone
    );
    const serviceId = cleanText(body.servico_id, 50);
    const date = cleanText(body.data, 10);
    const startTime = normalizeTime(body.hora_inicio || body.hora);
    const observations = cleanText(body.observacoes, 1000);

    if (
      !nome ||
      !validPhone(telefone) ||
      !serviceId ||
      !date ||
      !startTime
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Preencha nome, WhatsApp, serviço, data e horário.'
      });
    }

    if (!validId(serviceId) || !validDate(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Serviço ou data inválidos.'
      });
    }

    // Bloqueia horários anteriores à data/hora atual de São Paulo.
    if (isPastSlot(date, timeToMinutes(startTime))) {
      return res.status(409).json({
        ok: false,
        code: 'HORARIO_PASSADO',
        error: 'Esse horário já passou. Escolha outro horário disponível.'
      });
    }

    // Evita duplicidade por horário no mesmo processo do servidor.
    return await withBookingLock(date, async () => {
      // A disponibilidade é consultada novamente no momento da reserva.
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

      // Confere novamente o horário atual dentro da trava.
      if (isPastSlot(date, start)) {
        return res.status(409).json({
          ok: false,
          code: 'HORARIO_PASSADO',
          error: 'Esse horário já passou. Escolha outro horário.'
        });
      }

      if (!isSlotAvailable(context, start, end)) {
        return res.status(409).json({
          ok: false,
          code: 'HORARIO_INDISPONIVEL',
          error: 'Esse horário não está mais disponível. Atualize a agenda e escolha outro.'
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
        observacoes: observations,
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
      db()
        .from('clientes_taiany')
        .select('*')
        .order('nome', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/clientes', admin, async (req, res) => {
  try {
    const nome = cleanText(req.body?.nome, 150);
    const telefoneInformado = cleanText(req.body?.telefone, 40);
    const telefone = telefoneInformado
      ? normalizePhone(telefoneInformado)
      : '';
    const email = cleanText(req.body?.email, 200);

    if (!nome) {
      return res.status(400).json({
        ok: false,
        error: 'O nome do cliente é obrigatório.'
      });
    }

    if (telefone && !validPhone(telefone)) {
      return res.status(400).json({
        ok: false,
        error: 'O WhatsApp informado é inválido.'
      });
    }

    if (telefone) {
      const existente = await findClientByPhone(telefone);

      if (existente) {
        return res.status(409).json({
          ok: false,
          code: 'CLIENTE_EXISTENTE',
          error: 'Já existe um cliente com esse WhatsApp.'
        });
      }
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
      const telefone = normalizePhone(req.body.telefone);

      if (telefone && !validPhone(telefone)) {
        return res.status(400).json({
          ok: false,
          error: 'O WhatsApp informado é inválido.'
        });
      }

      if (telefone) {
        const existente = await findClientByPhone(telefone);

        if (existente && String(existente.id) !== id) {
          return res.status(409).json({
            ok: false,
            code: 'CLIENTE_EXISTENTE',
            error: 'Esse WhatsApp já está cadastrado em outro cliente.'
          });
        }
      }

      updates.telefone = telefone;
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

app.delete('/api/admin/clientes/:id', admin, async (req, res) => {
  const id = cleanText(req.params.id, 50);

  try {
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
      if (deleteError.code === '23503') {
        return res.status(409).json({
          ok: false,
          code: deleteError.code,
          error: 'Existem registros vinculados a este cliente. A exclusão foi bloqueada.'
        });
      }

      throw deleteError;
    }

    if (!deleted?.length) {
      return res.status(409).json({
        ok: false,
        error: 'O Supabase não confirmou a exclusão.'
      });
    }

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
    const duration = Number(
      req.body?.duracao_minutos ?? req.body?.duracao ?? 60
    );
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

    if (
      req.body?.duracao_minutos !== undefined ||
      req.body?.duracao !== undefined
    ) {
      const duration = Number(
        req.body.duracao_minutos ?? req.body.duracao
      );

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
      db()
        .from('disponibilidade')
        .select('*')
        .order('dia_semana', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/disponibilidade', admin, async (req, res) => {
  try {
    const day = Number(req.body?.dia_semana);
    const cidade = req.body?.cidade // 'Severínia' ou 'Olímpia'
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

// ======================================================
// ARQUIVOS ESTÁTICOS E SEGURANÇA
// ======================================================

app.use((req, res, next) => {
  let requested;

  try {
    requested = decodeURIComponent(req.path || '/');
  } catch {
    return res.status(400).end();
  }

  const forbidden = [
    /^\/server\.js$/i,
    /^\/package(?:-lock)?\.json$/i,
    /^\/\.env(?:\..*)?$/i,
    /^\/\.git(?:\/|$)/i,
    /^\/node_modules(?:\/|$)/i
  ];

  if (forbidden.some(pattern => pattern.test(requested))) {
    return res.status(404).end();
  }

  return next();
});

app.use(express.static(__dirname, {
  index: false,
  dotfiles: 'deny'
}));

// ======================================================
// ROTAS NÃO ENCONTRADAS
// ======================================================

app.use((req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'Rota não encontrada.'
  });
});

// ======================================================
// ERROS NÃO TRATADOS
// ======================================================

app.use((error, req, res, next) => {
  console.error('[ERRO NÃO TRATADO]', error);

  if (res.headersSent) return next(error);

  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    'body' in error
  ) {
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
