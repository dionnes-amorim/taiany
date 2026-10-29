// ======================================================
// SERVER.JS — TAIANY TRINDADE | NAIL DESIGNER
// Versão revisada: autenticação, Supabase, validações e CRUD
// ======================================================

import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
// CONFIGURAÇÃO E SESSÃO
// ======================================================

const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
  console.error(
    'ATENÇÃO: configure SESSION_SECRET nas variáveis de ambiente do Render.'
  );
}

app.use(
  session({
    name: 'taiany.sid',
    secret: sessionSecret || 'CHAVE_TEMPORARIA_INSEGURA_NAO_USAR_EM_PRODUCAO',
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
  })
);

// ======================================================
// SUPABASE
// ======================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  } catch (error) {
    console.error('Falha ao inicializar Supabase:', error.message);
  }
} else {
  console.error(
    'Supabase não configurado. Confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.'
  );
}

function db() {
  if (!supabase) {
    const error = new Error(
      'Banco de dados indisponível. Verifique as variáveis de ambiente do Render.'
    );
    error.status = 503;
    throw error;
  }

  return supabase;
}

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function cleanText(value, maxLength = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

function validId(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function validClienteId(value) {
  const str = String(value ?? '').trim();
  return Boolean(str) && (validId(str) || /^\d+$/.test(str));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function validTime(value) {
  return (
    typeof value === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)
  );
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

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function isCancelled(status) {
  return ['cancelado', 'cancelada', 'cancelled'].includes(
    String(status || '').trim().toLowerCase()
  );
}

// Mensagens controladas: erros internos ficam no log do servidor.
function sendDbError(res, error) {
  console.error('Erro no servidor/Supabase:', {
    message: error?.message,
    code: error?.code,
    details: error?.details,
    hint: error?.hint,
    status: error?.status
  });

  if (res.headersSent) return;

  const code = String(error?.code || '');
  const status = Number(error?.status);

  if (status === 503) {
    return res.status(503).json({
      ok: false,
      error: error.message
    });
  }

  if (code === '23503') {
    return res.status(409).json({
      ok: false,
      code,
      error:
        'Não é possível excluir este registro porque existem outros registros vinculados a ele. Verifique os vínculos no banco de dados.'
    });
  }

  if (code === '23505') {
    return res.status(409).json({
      ok: false,
      code,
      error: 'Já existe um registro com esses dados.'
    });
  }

  if (code === '22P02') {
    return res.status(400).json({
      ok: false,
      code,
      error: 'O formato de um dos dados enviados é inválido.'
    });
  }

  if (code === '42501') {
    return res.status(403).json({
      ok: false,
      code,
      error:
        'O banco de dados recusou a operação. Confira as permissões e a chave configurada no servidor.'
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
    error: 'Não foi possível concluir a operação. Tente novamente.'
  });
}

async function executeQuery(res, query) {
  try {
    const { data, error } = await query;

    if (error) return sendDbError(res, error);

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    return sendDbError(res, error);
  }
}

// Middleware para páginas administrativas.
function requireAuth(req, res, next) {
  if (req.session?.auth === true) return next();
  return res.redirect('/');
}

// Middleware para APIs administrativas.
function admin(req, res, next) {
  if (req.session?.auth === true) return next();

  return res.status(401).json({
    ok: false,
    error: 'Sessão expirada ou acesso não autorizado. Faça login novamente.'
  });
}

// ======================================================
// LOGIN / SESSÃO / LOGOUT
// ======================================================

app.post('/api/login', (req, res) => {
  try {
    const user = cleanText(req.body?.user, 100);
    const pass = String(req.body?.pass ?? '');
    const configuredUser = process.env.AUTH_USER;
    const configuredPass = process.env.AUTH_PASS;

    if (!configuredUser || !configuredPass) {
      return res.status(503).json({
        ok: false,
        error: 'Configure AUTH_USER e AUTH_PASS nas variáveis de ambiente do Render.'
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
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.get('/api/sessao', (req, res) => {
  res.json({
    ok: true,
    autenticado: req.session?.auth === true
  });
});

app.post('/api/logout', (req, res) => {
  if (!req.session) {
    return res.json({ ok: true });
  }

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
      const dia = Number(req.query.dia);

      if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
        return res.status(400).json({
          ok: false,
          error: 'Dia da semana inválido.'
        });
      }

      query = query.eq('dia_semana', dia);
    }

    return await executeQuery(res, query);
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// HORÁRIOS DISPONÍVEIS
// ======================================================

app.get('/api/horarios', async (req, res) => {
  try {
    const data = cleanText(req.query.data, 10);
    const servicoId = cleanText(req.query.servico_id, 50);

    if (!validDate(data)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe uma data válida no formato AAAA-MM-DD.'
      });
    }

    const supabaseClient = db();
    let duracao = 60;

    if (servicoId) {
      if (!validId(servicoId)) {
        return res.status(400).json({
          ok: false,
          error: 'Serviço inválido.'
        });
      }

      const { data: servico, error } = await supabaseClient
        .from('servicos')
        .select('*')
        .eq('id', servicoId)
        .maybeSingle();

      if (error) throw error;

      if (!servico) {
        return res.status(404).json({
          ok: false,
          error: 'Serviço não encontrado.'
        });
      }

      duracao = Number(servico.duracao_minutos || servico.duracao || 60);
    }

    if (!Number.isFinite(duracao) || duracao <= 0) duracao = 60;

    const [ano, mes, dia] = data.split('-').map(Number);
    const diaSemana = new Date(ano, mes - 1, dia, 12).getDay();

    const [dispResult, bloqueiosResult, agendamentosResult] =
      await Promise.all([
        supabaseClient
          .from('disponibilidade')
          .select('*')
          .eq('dia_semana', diaSemana),

        supabaseClient
          .from('bloqueios')
          .select('*')
          .eq('data', data),

        supabaseClient
          .from('agendamentos')
          .select('*')
          .eq('data', data)
      ]);

    if (dispResult.error) throw dispResult.error;
    if (bloqueiosResult.error) throw bloqueiosResult.error;
    if (agendamentosResult.error) throw agendamentosResult.error;

    const horarios = [];

    for (const faixa of dispResult.data || []) {
      if (faixa.ativo === false) continue;

      const inicio = timeToMinutes(faixa.hora_inicio);
      const fim = timeToMinutes(faixa.hora_fim);

      if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) {
        continue;
      }

      for (let horario = inicio; horario + duracao <= fim; horario += 30) {
        const horarioFim = horario + duracao;

        const bloqueado = (bloqueiosResult.data || []).some((bloqueio) => {
          const bInicio = timeToMinutes(bloqueio.hora_inicio);
          const bFim = timeToMinutes(bloqueio.hora_fim);

          return (
            Number.isFinite(bInicio) &&
            Number.isFinite(bFim) &&
            overlaps(horario, horarioFim, bInicio, bFim)
          );
        });

        const ocupado = (agendamentosResult.data || []).some((agendamento) => {
          if (isCancelled(agendamento.status)) return false;

          const aInicio = timeToMinutes(agendamento.hora_inicio);
          const aFim = timeToMinutes(agendamento.hora_fim);

          return (
            Number.isFinite(aInicio) &&
            Number.isFinite(aFim) &&
            overlaps(horario, horarioFim, aInicio, aFim)
          );
        });

        if (!bloqueado && !ocupado) {
          const hora = `${String(Math.floor(horario / 60)).padStart(2, '0')}:${String(
            horario % 60
          ).padStart(2, '0')}`;

          if (!horarios.includes(hora)) horarios.push(hora);
        }
      }
    }

    return res.json({
      ok: true,
      data: horarios.sort()
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

    const nomeCliente = cleanText(body.nome_cliente || body.nome, 150);
    const telefoneCliente = cleanText(
      body.telefone_cliente || body.telefone,
      40
    );
    const servicoId = cleanText(body.servico_id, 50);
    const data = cleanText(body.data, 10);
    const horaInicio = normalizeTime(body.hora_inicio || body.hora);
    const observacoes = cleanText(body.observacoes, 1000);

    if (!nomeCliente || !telefoneCliente || !servicoId || !data || !horaInicio) {
      return res.status(400).json({
        ok: false,
        error: 'Preencha nome, telefone, serviço, data e horário.'
      });
    }

    if (!validId(servicoId) || !validDate(data)) {
      return res.status(400).json({
        ok: false,
        error: 'Os dados do agendamento são inválidos.'
      });
    }

    const supabaseClient = db();

    const { data: servico, error: servicoError } = await supabaseClient
      .from('servicos')
      .select('*')
      .eq('id', servicoId)
      .maybeSingle();

    if (servicoError) throw servicoError;

    if (!servico) {
      return res.status(404).json({
        ok: false,
        error: 'O serviço selecionado não foi encontrado.'
      });
    }

    if (servico.ativo === false) {
      return res.status(409).json({
        ok: false,
        error: 'Este serviço não está disponível para agendamento.'
      });
    }

    const duracao = Number(servico.duracao_minutos || servico.duracao || 60);

    if (!Number.isFinite(duracao) || duracao <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'A duração do serviço está configurada incorretamente.'
      });
    }

    const inicioMinutos = timeToMinutes(horaInicio);

    if (!Number.isFinite(inicioMinutos)) {
      return res.status(400).json({
        ok: false,
        error: 'Horário inválido.'
      });
    }

    const fimMinutos = inicioMinutos + duracao;

    if (fimMinutos > 24 * 60) {
      return res.status(400).json({
        ok: false,
        error: 'O horário escolhido ultrapassa o final do dia.'
      });
    }

    const horaFim = `${String(Math.floor(fimMinutos / 60)).padStart(2, '0')}:${String(
      fimMinutos % 60
    ).padStart(2, '0')}:00`;

    const [ano, mes, dia] = data.split('-').map(Number);
    const diaSemana = new Date(ano, mes - 1, dia, 12).getDay();

    const [dispResult, bloqueiosResult, agendamentosResult] =
      await Promise.all([
        supabaseClient
          .from('disponibilidade')
          .select('*')
          .eq('dia_semana', diaSemana),

        supabaseClient
          .from('bloqueios')
          .select('*')
          .eq('data', data),

        supabaseClient
          .from('agendamentos')
          .select('*')
          .eq('data', data)
      ]);

    if (dispResult.error) throw dispResult.error;
    if (bloqueiosResult.error) throw bloqueiosResult.error;
    if (agendamentosResult.error) throw agendamentosResult.error;

    const dentroDaDisponibilidade = (dispResult.data || []).some((faixa) => {
      if (faixa.ativo === false) return false;

      const faixaInicio = timeToMinutes(faixa.hora_inicio);
      const faixaFim = timeToMinutes(faixa.hora_fim);

      return (
        Number.isFinite(faixaInicio) &&
        Number.isFinite(faixaFim) &&
        inicioMinutos >= faixaInicio &&
        fimMinutos <= faixaFim
      );
    });

    if (!dentroDaDisponibilidade) {
      return res.status(409).json({
        ok: false,
        error: 'Esse horário não está dentro da disponibilidade.'
      });
    }

    const bloqueado = (bloqueiosResult.data || []).some((bloqueio) => {
      const bInicio = timeToMinutes(bloqueio.hora_inicio);
      const bFim = timeToMinutes(bloqueio.hora_fim);

      return (
        Number.isFinite(bInicio) &&
        Number.isFinite(bFim) &&
        overlaps(inicioMinutos, fimMinutos, bInicio, bFim)
      );
    });

    if (bloqueado) {
      return res.status(409).json({
        ok: false,
        error: 'Esse horário está bloqueado. Escolha outro.'
      });
    }

    const ocupado = (agendamentosResult.data || []).some((agendamento) => {
      if (isCancelled(agendamento.status)) return false;

      const aInicio = timeToMinutes(agendamento.hora_inicio);
      const aFim = timeToMinutes(agendamento.hora_fim);

      return (
        Number.isFinite(aInicio) &&
        Number.isFinite(aFim) &&
        overlaps(inicioMinutos, fimMinutos, aInicio, aFim)
      );
    });

    if (ocupado) {
      return res.status(409).json({
        ok: false,
        error: 'Esse horário acabou de ser reservado. Escolha outro.'
      });
    }

    const novoAgendamento = {
      nome_cliente: nomeCliente,
      telefone_cliente: telefoneCliente,
      servico_id: servico.id,
      nome_servico: servico.nome,
      data,
      hora_inicio: horaInicio,
      hora_fim: horaFim,
      preco: Number(servico.preco || 0),
      status: 'Pendente',
      observacoes,
      origem: 'site'
    };

    const { data: criado, error: insertError } = await supabaseClient
      .from('agendamentos')
      .insert(novoAgendamento)
      .select()
      .single();

    if (insertError) throw insertError;

    return res.status(201).json({
      ok: true,
      data: criado,
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
      if (!validDate(String(req.query.data))) {
        return res.status(400).json({
          ok: false,
          error: 'Data de filtro inválida.'
        });
      }

      query = query.eq('data', String(req.query.data));
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
    const { id } = req.params;

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
    const { id } = req.params;

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

    if (!data || data.length === 0) {
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
// ADMIN — CLIENTES TAIANY
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

    const cliente = { nome };

    if (telefone) cliente.telefone = telefone;
    if (email) cliente.email = email;

    const { data, error } = await db()
      .from('clientes_taiany')
      .insert(cliente)
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
    const rawId = cleanText(req.params.id, 50);

    if (!validClienteId(rawId)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de cliente inválido.'
      });
    }

    // Mantém o ID como texto. Não converte BIGINT para Number,
    // evitando perda de precisão em identificadores grandes.
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
      .eq('id', rawId)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: 'Cliente não encontrado no Supabase.'
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

// ======================================================
// ADMIN — EXCLUSÃO DE CLIENTES: CORRIGIDA
// ======================================================

app.delete('/api/admin/clientes/:id', admin, async (req, res) => {
  const rawId = cleanText(req.params.id, 50);

  try {
    console.log('[CLIENTE DELETE] Solicitação recebida:', rawId);

    if (!validClienteId(rawId)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de cliente inválido.'
      });
    }

    const client = db();

    // 1. Confirma que o cliente existe.
    // 2. Não converte o ID numérico para Number.
    const { data: cliente, error: erroBusca } = await client
      .from('clientes_taiany')
      .select('id, nome')
      .eq('id', rawId)
      .maybeSingle();

    if (erroBusca) {
      console.error('[CLIENTE DELETE] Falha na busca:', erroBusca);
      throw erroBusca;
    }

    if (!cliente) {
      console.warn('[CLIENTE DELETE] Cliente não encontrado:', rawId);

      return res.status(404).json({
        ok: false,
        error: 'Cliente não encontrado. Atualize a lista e tente novamente.'
      });
    }

    console.log(
      '[CLIENTE DELETE] Cliente encontrado:',
      cliente.id,
      cliente.nome
    );

    // A exclusão precisa retornar o ID excluído.
    // Se o Supabase não retornar uma linha, não afirmamos sucesso.
    const { data: excluidos, error: erroDelete } = await client
      .from('clientes_taiany')
      .delete()
      .eq('id', rawId)
      .select('id');

    if (erroDelete) {
      console.error('[CLIENTE DELETE] Falha ao excluir:', erroDelete);

      if (erroDelete.code === '23503') {
        return res.status(409).json({
          ok: false,
          code: erroDelete.code,
          error:
            'Este cliente possui registros vinculados. Verifique as chaves estrangeiras e os agendamentos associados antes de excluir.'
        });
      }

      throw erroDelete;
    }

    if (!excluidos || excluidos.length === 0) {
      console.error(
        '[CLIENTE DELETE] Nenhuma linha foi excluída:',
        rawId
      );

      return res.status(409).json({
        ok: false,
        error:
          'O banco não confirmou a exclusão. Verifique as permissões, o ID e os vínculos do cliente.'
      });
    }

    console.log(
      '[CLIENTE DELETE] Exclusão confirmada:',
      excluidos[0].id
    );

    return res.json({
      ok: true,
      id: excluidos[0].id,
      message: 'Cliente excluído com sucesso.'
    });
  } catch (error) {
    console.error('[CLIENTE DELETE] Erro inesperado:', error);
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
    const duracao = Number(
      req.body?.duracao_minutos ?? req.body?.duracao ?? 60
    );
    const preco = Number(req.body?.preco ?? 0);

    if (!nome) {
      return res.status(400).json({
        ok: false,
        error: 'O nome do serviço é obrigatório.'
      });
    }

    if (!Number.isFinite(duracao) || duracao <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Informe uma duração válida para o serviço.'
      });
    }

    if (!Number.isFinite(preco) || preco < 0) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um preço válido.'
      });
    }

    const servico = {
      nome,
      descricao: cleanText(req.body?.descricao, 1000),
      duracao_minutos: duracao,
      preco
    };

    if (req.body?.ativo !== undefined) {
      servico.ativo = req.body.ativo === true || req.body.ativo === 'true';
    }

    const { data, error } = await db()
      .from('servicos')
      .insert(servico)
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
    const { id } = req.params;

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
      const duracao = Number(
        req.body.duracao_minutos ?? req.body.duracao
      );

      if (!Number.isFinite(duracao) || duracao <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Duração inválida.'
        });
      }

      updates.duracao_minutos = duracao;
    }

    if (req.body?.preco !== undefined) {
      const preco = Number(req.body.preco);

      if (!Number.isFinite(preco) || preco < 0) {
        return res.status(400).json({
          ok: false,
          error: 'Preço inválido.'
        });
      }

      updates.preco = preco;
    }

    if (req.body?.ativo !== undefined) {
      updates.ativo = req.body.ativo === true || req.body.ativo === 'true';
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
    const { id } = req.params;

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

    if (!data || data.length === 0) {
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
    const dia = Number(req.body?.dia_semana);
    const inicio = normalizeTime(req.body?.hora_inicio);
    const fim = normalizeTime(req.body?.hora_fim);

    if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
      return res.status(400).json({
        ok: false,
        error: 'Dia da semana inválido. Use de 0 a 6.'
      });
    }

    if (!inicio || !fim || timeToMinutes(inicio) >= timeToMinutes(fim)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe horários válidos, com o fim depois do início.'
      });
    }

    const registro = {
      dia_semana: dia,
      hora_inicio: inicio,
      hora_fim: fim
    };

    if (req.body?.ativo !== undefined) {
      registro.ativo = req.body.ativo === true || req.body.ativo === 'true';
    }

    const { data, error } = await db()
      .from('disponibilidade')
      .insert(registro)
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
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({
        ok: false,
        error: 'ID de disponibilidade inválido.'
      });
    }

    const updates = {};

    if (req.body?.dia_semana !== undefined) {
      const dia = Number(req.body.dia_semana);

      if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
        return res.status(400).json({
          ok: false,
          error: 'Dia da semana inválido.'
        });
      }

      updates.dia_semana = dia;
    }

    if (req.body?.hora_inicio !== undefined) {
      const inicio = normalizeTime(req.body.hora_inicio);

      if (!inicio) {
        return res.status(400).json({
          ok: false,
          error: 'Horário inicial inválido.'
        });
      }

      updates.hora_inicio = inicio;
    }

    if (req.body?.hora_fim !== undefined) {
      const fim = normalizeTime(req.body.hora_fim);

      if (!fim) {
        return res.status(400).json({
          ok: false,
          error: 'Horário final inválido.'
        });
      }

      updates.hora_fim = fim;
    }

    if (req.body?.ativo !== undefined) {
      updates.ativo = req.body.ativo === true || req.body.ativo === 'true';
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        error: 'Nenhum campo válido foi enviado.'
      });
    }

    if (
      updates.hora_inicio &&
      updates.hora_fim &&
      timeToMinutes(updates.hora_inicio) >= timeToMinutes(updates.hora_fim)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'O horário final deve ser posterior ao horário inicial.'
      });
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
    const { id } = req.params;

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

    if (!data || data.length === 0) {
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
      if (!validDate(String(req.query.data))) {
        return res.status(400).json({
          ok: false,
          error: 'Data de filtro inválida.'
        });
      }

      query = query.eq('data', String(req.query.data));
    }

    return await executeQuery(res, query);
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/bloqueios', admin, async (req, res) => {
  try {
    const data = cleanText(req.body?.data, 10);
    const inicio = normalizeTime(req.body?.hora_inicio);
    const fim = normalizeTime(req.body?.hora_fim);
    const motivo = cleanText(req.body?.motivo, 500);

    if (!validDate(data)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe uma data válida.'
      });
    }

    if (!inicio || !fim || timeToMinutes(inicio) >= timeToMinutes(fim)) {
      return res.status(400).json({
        ok: false,
        error: 'Informe um intervalo de horários válido.'
      });
    }

    const { data: bloqueio, error } = await db()
      .from('bloqueios')
      .insert({
        data,
        hora_inicio: inicio,
        hora_fim: fim,
        motivo
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      data: bloqueio
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.delete('/api/admin/bloqueios/:id', admin, async (req, res) => {
  try {
    const { id } = req.params;

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

    if (!data || data.length === 0) {
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

// Arquivos públicos: nunca coloque arquivos .env ou credenciais
// dentro da pasta pública do site.
app.use(
  express.static(__dirname, {
    index: false,
    dotfiles: 'deny'
  })
);

// ======================================================
// TRATAMENTO FINAL DE ROTAS E ERROS
// ======================================================

app.use((req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'Rota não encontrada.'
  });
});

app.use((error, req, res, next) => {
  console.error('Erro não tratado:', error);

  if (res.headersSent) return next(error);

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
