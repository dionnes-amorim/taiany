// ======================================================
// SERVER.JS — TAIANY TRINDADE | NAIL DESIGNER
// ======================================================

const express = require('express');
const session = require('express-session');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIGURAÇÃO
// ======================================================

app.disable('x-powered-by');

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.use(
  session({
    name: 'taiany.sid',
    secret: process.env.SESSION_SECRET || 'troque-esta-chave-antes-de-publicar',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

// ======================================================
// SUPABASE
// A chave de serviço fica somente no servidor.
// Configure as variáveis no Render.
// ======================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

function db() {
  if (!supabase) {
    const error = new Error(
      'Supabase não configurado. Verifique SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.'
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
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function validDate(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

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

function sendDbError(res, error) {
  console.error('Erro no servidor/Supabase:', error);

  const status = Number(error?.status) || 500;

  return res.status(status).json({
    ok: false,
    error:
      status === 503
        ? error.message
        : 'Não foi possível concluir a operação. Verifique os dados e tente novamente.'
  });
}

async function executeQuery(res, query) {
  try {
    const { data, error } = await query;

    if (error) {
      console.error('Erro Supabase:', error);
      return res.status(500).json({
        ok: false,
        error: 'Erro ao consultar o banco de dados.'
      });
    }

    return res.json({ ok: true, data });
  } catch (error) {
    return sendDbError(res, error);
  }
}

// ======================================================
// AUTENTICAÇÃO
// ======================================================

// Protege as páginas administrativas.
function requireAuth(req, res, next) {
  if (req.session && req.session.auth === true) {
    return next();
  }

  return res.redirect('/');
}

// Protege todas as APIs administrativas.
function admin(req, res, next) {
  if (req.session && req.session.auth === true) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: 'Sessão expirada ou acesso não autorizado. Faça login novamente.'
  });
}

// Login
app.post('/api/login', (req, res) => {
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
});

// Verifica se a sessão está ativa.
app.get('/api/sessao', (req, res) => {
  res.json({
    ok: true,
    autenticado: req.session?.auth === true
  });
});

// Logout
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
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    return res.json({ ok: true });
  });
});

// ======================================================
// SAÚDE DO SERVIDOR
// ======================================================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Taiany Trindade — Nail Designer',
    supabaseConfigured: Boolean(supabase)
  });
});

// ======================================================
// SERVIÇOS — API PÚBLICA
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
// DISPONIBILIDADE — API PÚBLICA
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

    // Busca o serviço para identificar sua duração.
    let duracao = 60;

    if (servicoId) {
      if (!validId(servicoId)) {
        return res.status(400).json({
          ok: false,
          error: 'Serviço inválido.'
        });
      }

      const { data: servico, error: servicoError } = await supabaseClient
        .from('servicos')
        .select('*')
        .eq('id', servicoId)
        .maybeSingle();

      if (servicoError) throw servicoError;

      if (!servico) {
        return res.status(404).json({
          ok: false,
          error: 'Serviço não encontrado.'
        });
      }

      duracao = Number(
        servico.duracao_minutos || servico.duracao || 60
      );
    }

    if (!Number.isFinite(duracao) || duracao <= 0) {
      duracao = 60;
    }

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

    const disponibilidade = dispResult.data || [];
    const bloqueios = bloqueiosResult.data || [];
    const agendamentos = agendamentosResult.data || [];

    const horarios = [];

    for (const faixa of disponibilidade) {
      const inicio = timeToMinutes(faixa.hora_inicio);
      const fim = timeToMinutes(faixa.hora_fim);

      if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) {
        continue;
      }

      // Gera horários em intervalos de 30 minutos.
      for (
        let horario = inicio;
        horario + duracao <= fim;
        horario += 30
      ) {
        const horarioFim = horario + duracao;

        const bloqueado = bloqueios.some((bloqueio) => {
          const bInicio = timeToMinutes(bloqueio.hora_inicio);
          const bFim = timeToMinutes(bloqueio.hora_fim);

          return (
            Number.isFinite(bInicio) &&
            Number.isFinite(bFim) &&
            overlaps(horario, horarioFim, bInicio, bFim)
          );
        });

        const ocupado = agendamentos.some((agendamento) => {
          const status = String(agendamento.status || '').toLowerCase();

          if (
            ['cancelado', 'cancelada', 'cancelled'].includes(status)
          ) {
            return false;
          }

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

          if (!horarios.includes(hora)) {
            horarios.push(hora);
          }
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
// CRIAR AGENDAMENTO — API PÚBLICA
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

    if (!validId(servicoId) || !validDate(data) || !horaInicio) {
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

    const duracao = Number(
      servico.duracao_minutos || servico.duracao || 60
    );

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
      const status = String(agendamento.status || '').toLowerCase();

      if (['cancelado', 'cancelada', 'cancelled'].includes(status)) {
        return false;
      }

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

    const agendamento = {
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
      .insert(agendamento)
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

    if (req.query.data && validDate(String(req.query.data))) {
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

    const allowed = ['status', 'observacoes'];
    const updates = {};

    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        updates[key] =
          key === 'status'
            ? cleanText(req.body[key], 50)
            : cleanText(req.body[key], 1000);
      }
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
      .single();

    if (error) throw error;

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

    const { error } = await db()
      .from('agendamentos')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return res.json({ ok: true });
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
        .from('clientes')
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
      .from('clientes')
      .insert(cliente)
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, data });
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
      db()
        .from('servicos')
        .select('*')
        .order('nome', { ascending: true })
    );
  } catch (error) {
    return sendDbError(res, error);
  }
});

app.post('/api/admin/servicos', admin, async (req, res) => {
  try {
    const nome = cleanText(req.body?.nome, 150);

    if (!nome) {
      return res.status(400).json({
        ok: false,
        error: 'O nome do serviço é obrigatório.'
      });
    }

    const duracao = Number(
      req.body?.duracao_minutos ?? req.body?.duracao ?? 60
    );

    const preco = Number(req.body?.preco ?? 0);

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
      servico.ativo = Boolean(req.body.ativo);
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
      updates.nome = cleanText(req.body.nome, 150);
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
      updates.ativo = Boolean(req.body.ativo);
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
      .single();

    if (error) throw error;

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

    const { error } = await db()
      .from('servicos')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return res.json({ ok: true });
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
      registro.ativo = Boolean(req.body.ativo);
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
      updates.ativo = Boolean(req.body.ativo);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        ok: false,
        error: 'Nenhum campo válido foi enviado.'
      });
    }

    const { data, error } = await db()
      .from('disponibilidade')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

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

    const { error } = await db()
      .from('disponibilidade')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// ADMIN — BLOQUEIOS DE AGENDA
// ======================================================

app.get('/api/admin/bloqueios', admin, async (req, res) => {
  try {
    let query = db()
      .from('bloqueios')
      .select('*')
      .order('data', { ascending: true });

    if (req.query.data && validDate(String(req.query.data))) {
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

    const { error } = await db()
      .from('bloqueios')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ======================================================
// PÁGINAS HTML
// ======================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/taiany-painel-admin.html', requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, 'taiany-painel-admin.html')
  );
});

app.get('/taiany-agendamento.html', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'taiany-agendamento.html')
  );
});

app.get('/agendar', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'taiany-agendamento.html')
  );
});

// ======================================================
// ARQUIVOS ESTÁTICOS
// ======================================================

app.use(
  express.static(__dirname, {
    index: false,
    dotfiles: 'deny'
  })
);

// ======================================================
// ROTA NÃO ENCONTRADA
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Rota não encontrada.'
  });
});

// ======================================================
// ERROS NÃO TRATADOS
// ======================================================

app.use((error, req, res, next) => {
  console.error('Erro não tratado:', error);

  if (res.headersSent) {
    return next(error);
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
});
