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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});