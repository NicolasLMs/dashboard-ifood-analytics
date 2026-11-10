require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.DB_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
});

// 1. Rota para listar os restaurantes e preencher o <select> no HTML
app.get('/api/restaurantes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, categoria_principal FROM restaurante ORDER BY nome ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar restaurantes' });
  }
});

// 2. Rota principal do Dashboard com filtros dinâmicos
app.get('/api/dashboard', async (req, res) => {
  const { restauranteId, status, dataInicio, dataFim } = req.query;

  // Construção dinâmica do filtro WHERE para a tabela "pedido" (alias "ped")
  const filtros = [];
  const valores = [];

  if (restauranteId && restauranteId !== 'todos') {
    valores.push(restauranteId);
    filtros.push(`ped.restaurante_id = $${valores.length}`);
  }

  if (status && status !== 'todos') {
    valores.push(status);
    filtros.push(`ped.status = $${valores.length}`);
  }

  if (dataInicio) {
    valores.push(`${dataInicio} 00:00:00`);
    filtros.push(`ped.criado_em >= $${valores.length}`);
  }

  if (dataFim) {
    valores.push(`${dataFim} 23:59:59`);
    filtros.push(`ped.criado_em <= $${valores.length}`);
  }

  const whereClause = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  try {
    // Query A: Top 10 Produtos (Quantidade e Faturamento)
    const queryTop10 = `
      SELECT 
        COALESCE(p.nome, ip.nome_produto) AS produto,
        r.nome AS restaurante,
        SUM(ip.quantidade)::INT AS total_vendido,
        ROUND(SUM(ip.subtotal_item)::NUMERIC, 2)::FLOAT AS faturamento_produto
      FROM item_pedido ip
      JOIN pedido ped ON ip.pedido_id = ped.id
      LEFT JOIN produto p ON ip.produto_id = p.id
      LEFT JOIN restaurante r ON ped.restaurante_id = r.id
      ${whereClause}
      GROUP BY COALESCE(p.nome, ip.nome_produto), r.nome
      ORDER BY total_vendido DESC, faturamento_produto DESC
      LIMIT 10;
    `;

    // Query B: Indicadores Gerais (KPIs dos pedidos filtrados)
    const queryKPIs = `
      SELECT 
        COUNT(DISTINCT ped.id)::INT AS total_pedidos,
        COALESCE(ROUND(SUM(ped.total)::NUMERIC, 2), 0)::FLOAT AS faturamento_total,
        COALESCE(ROUND(AVG(ped.total)::NUMERIC, 2), 0)::FLOAT AS ticket_medio
      FROM pedido ped
      ${whereClause};
    `;

    // Query C: Evolução de Vendas por Dia (Gráfico de Linha)
    const queryPorDia = `
      SELECT 
        TO_CHAR(ped.criado_em, 'DD/MM') AS data_formatada,
        DATE(ped.criado_em) AS data_ordem,
        COUNT(ped.id)::INT AS qtd_pedidos,
        ROUND(SUM(ped.total)::NUMERIC, 2)::FLOAT AS faturamento_dia
      FROM pedido ped
      ${whereClause}
      GROUP BY DATE(ped.criado_em), TO_CHAR(ped.criado_em, 'DD/MM')
      ORDER BY data_ordem ASC;
    `;

    const [resTop10, resKPIs, resPorDia] = await Promise.all([
      pool.query(queryTop10, valores),
      pool.query(queryKPIs, valores),
      pool.query(queryPorDia, valores),
    ]);

    const totalItensVendidos = resTop10.rows.reduce((acc, item) => acc + item.total_vendido, 0);

    res.json({
      kpis: {
        ...resKPIs.rows[0],
        total_itens_top10: totalItensVendidos,
      },
      top10: resTop10.rows,
      evolucao: resPorDia.rows,
    });
  } catch (err) {
    console.error('Erro na rota /api/dashboard:', err);
    res.status(500).json({ erro: 'Erro ao processar dados do dashboard' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS DO DASHBOARD DE RESTAURANTES
// ─────────────────────────────────────────────────────────────────────────────

// R1. Lista restaurantes para o <select>
app.get('/api/restaurantes/lista', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nome, categoria_principal FROM restaurante ORDER BY nome ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar restaurantes' });
  }
});

// R2. Rota principal do Dashboard de Restaurantes
app.get('/api/restaurantes/dashboard', async (req, res) => {
  const { dataInicio, dataFim } = req.query;

  const filtrosPedido = [];
  const valores = [];

  if (dataInicio) {
    valores.push(`${dataInicio} 00:00:00`);
    filtrosPedido.push(`ped.criado_em >= $${valores.length}`);
  }
  if (dataFim) {
    valores.push(`${dataFim} 23:59:59`);
    filtrosPedido.push(`ped.criado_em <= $${valores.length}`);
  }

  const whereClause = filtrosPedido.length > 0 ? `WHERE ${filtrosPedido.join(' AND ')}` : '';

  try {
    // KPIs gerais de restaurantes
    const queryKPIs = `
      SELECT
        COUNT(DISTINCT r.id)::INT                                        AS total_restaurantes,
        COUNT(DISTINCT CASE WHEN ped.status NOT IN ('CANCELADO','AGUARDANDO_PAGAMENTO') THEN ped.id END)::INT AS total_pedidos,
        COALESCE(ROUND(SUM(CASE WHEN ped.status NOT IN ('CANCELADO','AGUARDANDO_PAGAMENTO') THEN ped.total ELSE 0 END)::NUMERIC,2),0)::FLOAT AS faturamento_total,
        COUNT(DISTINCT p.id)::INT                                        AS total_produtos
      FROM restaurante r
      LEFT JOIN pedido ped ON ped.restaurante_id = r.id ${filtrosPedido.length > 0 ? 'AND ' + filtrosPedido.join(' AND ') : ''}
      LEFT JOIN produto p ON p.restaurante_id = r.id;
    `;

    // Receita bruta por restaurante
    const queryReceitaPorRestaurante = `
      SELECT
        r.nome AS restaurante,
        r.categoria_principal AS categoria,
        COUNT(DISTINCT ped.id)::INT                                              AS total_pedidos,
        COALESCE(ROUND(SUM(ped.total)::NUMERIC, 2), 0)::FLOAT                   AS receita_total,
        COALESCE(ROUND(AVG(ped.total)::NUMERIC, 2), 0)::FLOAT                   AS ticket_medio,
        COUNT(DISTINCT CASE WHEN ped.status = 'CANCELADO' THEN ped.id END)::INT AS pedidos_cancelados
      FROM restaurante r
      LEFT JOIN pedido ped ON ped.restaurante_id = r.id
        AND ped.status NOT IN ('CANCELADO','AGUARDANDO_PAGAMENTO')
        ${filtrosPedido.length > 0 ? 'AND ' + filtrosPedido.join(' AND ') : ''}
      GROUP BY r.id, r.nome, r.categoria_principal
      ORDER BY receita_total DESC;
    `;

    // Market share (% do faturamento total por restaurante)
    const queryMarketShare = `
      SELECT
        r.nome AS restaurante,
        COALESCE(ROUND(SUM(ped.total)::NUMERIC, 2), 0)::FLOAT AS receita_total
      FROM restaurante r
      LEFT JOIN pedido ped ON ped.restaurante_id = r.id
        AND ped.status NOT IN ('CANCELADO','AGUARDANDO_PAGAMENTO')
        ${filtrosPedido.length > 0 ? 'AND ' + filtrosPedido.join(' AND ') : ''}
      GROUP BY r.id, r.nome
      ORDER BY receita_total DESC;
    `;

    // Pedidos por status (por restaurante — para gráfico de barras empilhadas)
    const queryPedidosPorStatus = `
      SELECT
        r.nome AS restaurante,
        ped.status::TEXT AS status,
        COUNT(ped.id)::INT AS total
      FROM restaurante r
      LEFT JOIN pedido ped ON ped.restaurante_id = r.id
        ${filtrosPedido.length > 0 ? 'AND ' + filtrosPedido.join(' AND ') : ''}
      WHERE ped.id IS NOT NULL
      GROUP BY r.nome, ped.status
      ORDER BY r.nome, ped.status;
    `;

    // Evolução de pedidos por dia (todos os restaurantes juntos)
    const queryEvolucao = `
      SELECT
        TO_CHAR(ped.criado_em, 'DD/MM') AS data_formatada,
        DATE(ped.criado_em)             AS data_ordem,
        COUNT(ped.id)::INT              AS qtd_pedidos,
        ROUND(SUM(ped.total)::NUMERIC, 2)::FLOAT AS faturamento_dia
      FROM pedido ped
      ${whereClause}
      GROUP BY DATE(ped.criado_em), TO_CHAR(ped.criado_em, 'DD/MM')
      ORDER BY data_ordem ASC;
    `;

    // Top 5 produtos mais vendidos globalmente
    const queryTopProdutos = `
      SELECT
        COALESCE(p.nome, ip.nome_produto)   AS produto,
        r.nome                              AS restaurante,
        SUM(ip.quantidade)::INT             AS total_vendido,
        ROUND(SUM(ip.subtotal_item)::NUMERIC, 2)::FLOAT AS faturamento_produto
      FROM item_pedido ip
      JOIN pedido ped ON ip.pedido_id = ped.id
      LEFT JOIN produto p ON ip.produto_id = p.id
      LEFT JOIN restaurante r ON ped.restaurante_id = r.id
      ${whereClause}
      GROUP BY COALESCE(p.nome, ip.nome_produto), r.nome
      ORDER BY total_vendido DESC
      LIMIT 5;
    `;

    const [
      resKPIs,
      resReceita,
      resMarketShare,
      resStatus,
      resEvolucao,
      resTopProdutos,
    ] = await Promise.all([
      pool.query(queryKPIs, valores),
      pool.query(queryReceitaPorRestaurante, valores),
      pool.query(queryMarketShare, valores),
      pool.query(queryPedidosPorStatus, valores),
      pool.query(queryEvolucao, valores),
      pool.query(queryTopProdutos, valores),
    ]);

    res.json({
      kpis:          resKPIs.rows[0],
      receita:       resReceita.rows,
      marketShare:   resMarketShare.rows,
      statusPorRest: resStatus.rows,
      evolucao:      resEvolucao.rows,
      topProdutos:   resTopProdutos.rows,
    });
  } catch (err) {
    console.error('Erro na rota /api/restaurantes/dashboard:', err);
    res.status(500).json({ erro: 'Erro ao processar dados do dashboard de restaurantes' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});