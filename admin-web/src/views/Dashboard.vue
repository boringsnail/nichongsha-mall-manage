<template>
  <div class="dash" v-loading="loading">
    <!-- 工具条：范围切换 + 数据时点 -->
    <div class="bar">
      <div class="bar-left">
        <span class="label">range</span>
        <el-radio-group v-model="days" size="small" @change="load">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
      </div>
      <div class="bar-right">
        <span class="mono stamp">数据截至 {{ updatedText }}</span>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!-- 仪表读数：一格一个指标，发丝线分隔，不做六张卡片 -->
    <section class="panel kpi-panel">
      <div v-for="card in statCards" :key="card.label" class="kpi" :class="card.tone">
        <div class="label">{{ card.label }}</div>
        <div class="kpi-val">
          <span class="num">{{ card.value }}</span>
          <span class="unit">{{ card.unit }}</span>
        </div>
      </div>
    </section>

    <!-- 营收口径：用一条算式把总营业额→净营业额讲清楚，商家不用再问「净额怎么算的」 -->
    <section class="panel rev-panel">
      <div class="panel-hd">
        <span class="rule-title">营收口径</span>
        <span class="label">近 {{ days }} 天 · 单位 元</span>
      </div>
      <div class="panel-bd rev-bd">
        <div v-if="revenue" class="rev-eq">
          <div class="rev-cell">
            <div class="label">总营业额</div>
            <div class="rev-num">{{ fenToYuan(revenue.gross) }}</div>
            <div class="rev-sub">含顾客付运费 {{ fenToYuan(revenue.freight) }}</div>
          </div>
          <span class="rev-op">−</span>
          <div class="rev-cell">
            <div class="label">退款</div>
            <div class="rev-num neg">{{ fenToYuan(revenue.refund) }}</div>
            <div class="rev-sub">已发生的退款</div>
          </div>
          <span class="rev-op">−</span>
          <div class="rev-cell">
            <div class="label">配送成本</div>
            <div class="rev-num neg">{{ fenToYuan(revenue.deliveryCost) }}</div>
            <div class="rev-sub">付给骑手/快递</div>
          </div>
          <span class="rev-op eq">=</span>
          <div class="rev-cell net">
            <div class="label">净营业额</div>
            <div class="rev-num">{{ fenToYuan(revenue.net) }}</div>
            <div class="rev-sub">净利率 {{ revenue.netRate }}%</div>
          </div>
        </div>
        <div v-if="revenue" class="rev-meta">
          <div class="rev-meta-row">
            <span class="label">订单</span>
            <b class="num">{{ revenue.orderCount }}</b>
          </div>
          <div class="rev-meta-row">
            <span class="label">客单价</span>
            <b class="num">{{ fenToYuan(revenue.aov) }}</b>
          </div>
          <!-- 没录成本的订单会让净额虚高，必须显式提醒，否则商家会拿错数字做决策 -->
          <div v-if="revenue.missingDeliveryCost > 0" class="rev-warn">
            {{ revenue.missingDeliveryCost }} 单未录配送成本，净额偏高
            <router-link to="/orders" class="rev-link">去录入 →</router-link>
          </div>
          <div v-else class="rev-ok">配送成本已全部录入</div>
        </div>
      </div>
    </section>

    <!-- 趋势 + 漏斗 -->
    <div class="grid cols-2-1">
      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">近 {{ days }} 天经营趋势</span>
          <span class="label">gmv / net / orders</span>
        </div>
        <div class="panel-bd">
          <div ref="trendRef" class="chart" />
        </div>
      </section>

      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">转化漏斗</span>
          <span class="label">session</span>
        </div>
        <div class="panel-bd">
          <div ref="funnelRef" class="chart" />
          <div v-if="funnel && funnel.worst" class="worst">
            最大流失 {{ funnel.worst.from }} → {{ funnel.worst.to }}
            <strong class="num">{{ funnel.worst.dropRate }}%</strong>
          </div>
        </div>
      </section>
    </div>

    <!-- 经营建议：按严重程度排序的待办清单 -->
    <section class="panel">
      <div class="panel-hd">
        <span class="rule-title">经营建议</span>
        <span class="label">{{ advice.length }} items</span>
      </div>
      <div class="panel-bd advice-bd">
        <div v-if="advice.length === 0" class="empty">各项指标均在健康区间，暂无建议</div>
        <div v-for="(a, i) in advice" :key="i" class="advice" :class="a.level">
          <span class="advice-tag mono">{{ levelText(a.level) }}</span>
          <div class="advice-body">
            <div class="advice-title">{{ a.title }}</div>
            <div class="advice-detail">{{ a.detail }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- TOP 商品 + 低库存 -->
    <div class="grid cols-2-1">
      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">商品销量 TOP {{ topN }}</span>
          <!-- 排行有自己的时间窗：看年榜时不用把整页都切到一年 -->
          <div class="hd-tools">
            <el-radio-group v-model="topDays" size="small" @change="loadTop">
              <el-radio-button :value="30">30 天</el-radio-button>
              <el-radio-button :value="90">90 天</el-radio-button>
              <el-radio-button :value="365">1 年</el-radio-button>
            </el-radio-group>
            <el-select v-model="topN" size="small" class="n-select" @change="loadTop">
              <el-option v-for="n in TOP_N_OPTIONS" :key="n" :label="`TOP ${n}`" :value="n" />
            </el-select>
          </div>
        </div>
        <div v-loading="topLoading" class="panel-bd">
          <div v-if="topProducts.length === 0" class="empty">该时间窗内还没有销量</div>
          <template v-else>
            <div ref="topRef" class="chart chart-sm" />
            <div class="chart-hint">点击柱状图查看单品售卖趋势</div>
          </template>
        </div>
      </section>

      <section class="panel">
        <div class="panel-hd">
          <span class="rule-title">低库存预警</span>
          <!-- 真实店铺常有几百个 0 库存 SKU，这里只报数量，明细去库存管理看 -->
          <span class="label">{{ lowStock.length }} sku · stock ≤ 10</span>
        </div>
        <div class="panel-bd lowstock-bd">
          <div v-if="lowStock.length === 0" class="empty">暂无低库存商品</div>
          <el-table v-else :data="lowStock" size="small" max-height="258">
            <el-table-column label="商品" min-width="120">
              <template #default="{ row }">
                <div class="prod">{{ row.productName }}</div>
                <div class="muted">{{ row.specName }}</div>
              </template>
            </el-table-column>
            <el-table-column label="库存" width="70" align="right">
              <template #default="{ row }">
                <span class="mono stock" :class="row.stock <= 5 ? 'crit' : 'warn'">{{ row.stock }}</span>
              </template>
            </el-table-column>
          </el-table>
          <router-link v-if="lowStock.length > 8" to="/stock" class="lowstock-more">
            共 {{ lowStock.length }} 个 SKU 待补货，去库存管理 →
          </router-link>
        </div>
      </section>
    </div>

    <!-- 搜索分析：商家最想知道「用户想买什么却搜不到」，所以无结果词单独一栏 -->
    <section class="panel">
      <div class="panel-hd">
        <span class="rule-title">搜索分析</span>
        <span class="label">近 {{ days }} 天</span>
      </div>
      <div v-loading="searchLoading" class="panel-bd search-bd">
        <div class="search-top">
          <div class="search-kpi">
            <div class="sk">
              <div class="label">搜索次数</div>
              <div class="sk-num">{{ searchStats?.total ?? '—' }}</div>
            </div>
            <div class="sk">
              <div class="label">搜索人数</div>
              <div class="sk-num">{{ searchStats?.uniqueUsers ?? '—' }}</div>
            </div>
            <div class="sk" :class="{ warn: (searchStats?.zeroRate ?? 0) >= 20 }">
              <div class="label">无结果率</div>
              <div class="sk-num">{{ searchStats ? `${searchStats.zeroRate}%` : '—' }}</div>
              <div class="sk-sub">{{ searchStats?.zeroResult ?? 0 }} 次没搜到东西</div>
            </div>
          </div>
          <div class="search-chart">
            <div ref="searchTrendRef" class="chart chart-xs" />
          </div>
        </div>

        <div class="search-cols">
          <div class="kw-col">
            <div class="kw-hd"><span class="label">热搜词</span><span class="label">times</span></div>
            <div v-if="!searchStats?.topKeywords.length" class="empty">暂无搜索记录</div>
            <div v-for="k in searchStats?.topKeywords ?? []" :key="k.keyword" class="kw-row">
              <span class="kw-text" :title="k.keyword">{{ k.keyword }}</span>
              <span class="kw-bar"><i :style="{ width: kwWidth(k.count, 'top') }" /></span>
              <span class="mono kw-num">{{ k.count }}</span>
            </div>
          </div>
          <div class="kw-col">
            <div class="kw-hd"><span class="label">搜了没结果</span><span class="label">times</span></div>
            <div v-if="!searchStats?.zeroKeywords.length" class="empty">没有无结果的关键词</div>
            <div v-for="k in searchStats?.zeroKeywords ?? []" :key="k.keyword" class="kw-row zero">
              <span class="kw-text" :title="k.keyword">{{ k.keyword }}</span>
              <span class="kw-bar"><i :style="{ width: kwWidth(k.zeroCount, 'zero') }" /></span>
              <span class="mono kw-num">{{ k.zeroCount }}</span>
            </div>
          </div>
        </div>

        <div class="user-hd">
          <span class="label">按用户搜索记录</span>
          <span class="label">最近 {{ searchStats?.users.length ?? 0 }} 人</span>
        </div>
        <el-table :data="searchStats?.users ?? []" size="small" empty-text="暂无用户搜索记录">
          <el-table-column label="用户" min-width="200">
            <template #default="{ row }">
              <div>{{ row.nickname || '微信用户' }}</div>
              <div class="muted uid" :title="row.openid">{{ row.openid }}</div>
            </template>
          </el-table-column>
          <el-table-column label="搜索次数" width="96" align="right">
            <template #default="{ row }"><span class="mono">{{ row.count }}</span></template>
          </el-table-column>
          <el-table-column label="最近搜索" min-width="150">
            <template #default="{ row }"><span class="kw-last">{{ row.lastKeyword }}</span></template>
          </el-table-column>
          <el-table-column label="最近时间" width="176">
            <template #default="{ row }"><span class="mono muted">{{ formatTime(row.lastAt) }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="92" :fixed="isMobile ? false : 'right'">
            <template #default="{ row }">
              <el-button link type="primary" @click="openUserLogs(row)">记录</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <!-- 单品售卖趋势：从 TOP 榜单点柱子进来 -->
    <el-drawer v-model="prodVisible" :title="prodTrend?.name || '单品售卖趋势'" size="620px" destroy-on-close>
      <div v-loading="prodLoading" class="prod-drawer">
        <template v-if="prodTrend">
          <div class="prod-hd">
            <!-- 没配封面图时 el-image 会渲染「加载失败」并把 56px 的框撑破，这里自己兜一个占位 -->
            <el-image v-if="prodTrend.coverImage" :src="prodTrend.coverImage" fit="cover" class="prod-cover" />
            <div v-else class="prod-cover ph">无图</div>
            <div>
              <div class="prod-name">{{ prodTrend.name }}</div>
              <div class="prod-tags">
                <el-tag size="small" :type="prodTrend.status === 'ON' ? 'success' : 'info'">
                  {{ prodTrend.status === 'ON' ? '在售' : '下架' }}
                </el-tag>
                <span class="muted">累计销量 {{ prodTrend.lifetimeSales }} 件</span>
              </div>
            </div>
          </div>
          <div class="prod-kpi">
            <div class="pk">
              <div class="label">窗口销量</div>
              <div class="sk-num">{{ prodTrend.totalSales }}</div>
            </div>
            <div class="pk">
              <div class="label">窗口 GMV</div>
              <div class="sk-num">{{ fenToYuan(prodTrend.totalGmv) }}</div>
            </div>
            <div class="pk">
              <div class="label">订单数</div>
              <div class="sk-num">{{ prodTrend.orderCount }}</div>
            </div>
            <div class="pk">
              <div class="label">日均</div>
              <div class="sk-num">{{ prodDaily }}</div>
            </div>
          </div>
          <div class="prod-range">
            <el-radio-group v-model="prodDays" size="small" @change="() => loadProdTrend()">
              <el-radio-button :value="30">30 天</el-radio-button>
              <el-radio-button :value="90">90 天</el-radio-button>
              <el-radio-button :value="365">1 年</el-radio-button>
            </el-radio-group>
            <span class="label">sales / gmv</span>
          </div>
          <div ref="prodChartRef" class="chart chart-md" />
          <div class="prod-note">
            折线为每日销量，柱为每日 GMV；空白天没有成交。点 TOP 榜里的其他柱子可切换商品。
          </div>
        </template>
      </div>
    </el-drawer>

    <!-- 单个用户的搜索流水 -->
    <el-dialog v-model="logsVisible" :title="logsTitle" width="560px">
      <div v-loading="logsLoading">
        <el-table :data="logs" size="small" empty-text="该用户还没有搜索记录">
          <el-table-column label="关键词" min-width="150">
            <template #default="{ row }"><span class="kw-last">{{ row.keyword }}</span></template>
          </el-table-column>
          <el-table-column label="结果数" width="84" align="right">
            <template #default="{ row }">
              <span class="mono" :class="{ 'zero-num': row.resultCount === 0 }">{{ row.resultCount }}</span>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="176">
            <template #default="{ row }"><span class="mono muted">{{ formatTime(row.createdAt) }}</span></template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <span class="muted">仅显示最近 50 条</span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, FunnelChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import { ElMessage } from 'element-plus';
import { useIsMobile } from '@/composables/useIsMobile';
import {
  adminAdvice,
  adminFunnel,
  adminLowStock,
  adminOverview,
  adminProductTrend,
  adminRevenue,
  adminSearchLogs,
  adminSearchStats,
  adminTopProducts,
  adminTrend,
  type Advice,
  type FunnelData,
  type LowStockSku,
  type Overview,
  type ProductTrend,
  type Revenue,
  type SearchLogRow,
  type SearchStats,
  type SearchUserRow,
  type TopProduct,
  type TrendPoint,
} from '@/api/stats';
import { fenToYuan } from '@/utils/money';
import { useThemeStore } from '@/stores/theme';

const { isMobile } = useIsMobile();
const theme = useThemeStore();

// 按需注册，避免整包打入（Dashboard chunk 可减小数百 KB）
echarts.use([
  BarChart,
  LineChart,
  FunnelChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

// ---- 图表色板：canvas 里拿不到 CSS 变量，只能在渲染时读一次令牌再显式给色 ----
// 这样浅色（雾白）/ 深色（石墨）两套主题下，坐标轴、网格、tooltip 都会跟着变。
const MONO = 'JetBrains Mono Variable, monospace';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

type Palette = ReturnType<typeof readPalette>;

function readPalette() {
  return {
    signal: cssVar('--signal', '#0a7566'),
    amber: cssVar('--amber', '#8f5c09'),
    axis: cssVar('--line-2', '#d3d9e2'),
    axisLabel: cssVar('--text-lo', '#8a94a3'),
    textMid: cssVar('--text-mid', '#4a5563'),
    gridLine: cssVar('--line-1', '#e4e8ee'),
    panel: cssVar('--ink-850', '#ffffff'),
    overlay: cssVar('--ink-820', '#ffffff'),
    textHi: cssVar('--text-hi', '#101419'),
    blue: cssVar('--blue', '#2457cc'),
    red: cssVar('--red', '#c03333'),
    shadow: cssVar('--shadow-2', '0 14px 36px rgba(0,0,0,.16)'),
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 把 a 往 b 掺 t（0=全 a，1=全 b），用来生成漏斗的明度阶梯 */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${c(r1, r2)}, ${c(g1, g2)}, ${c(b1, b2)})`;
}

/** 深底配浅字、浅底配深字：漏斗每级底色不同，字色必须逐级算 */
function inkOn(bg: string): string {
  const [r, g, b] = hexToRgb(bg);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.55 ? '#ffffff' : '#0b1418';
}

function tooltipStyle(p: Palette) {
  return {
    backgroundColor: p.overlay,
    borderColor: p.axis,
    borderWidth: 1,
    padding: [8, 10] as [number, number],
    textStyle: { color: p.textHi, fontSize: 11, fontFamily: MONO },
    extraCssText: `box-shadow: ${p.shadow}; border-radius: 2px;`,
  };
}

function axisCommon(p: Palette) {
  return {
    axisLine: { lineStyle: { color: p.axis } },
    axisTick: { show: false },
    axisLabel: { color: p.axisLabel, fontSize: 10, fontFamily: MONO },
  };
}

const loading = ref(false);
const days = ref(30);
const overview = ref<Overview | null>(null);
const trend = ref<TrendPoint[]>([]);
const funnel = ref<FunnelData | null>(null);
const advice = ref<Advice[]>([]);
const topProducts = ref<TopProduct[]>([]);
const lowStock = ref<LowStockSku[]>([]);
const updatedText = ref('—');

// ---- 营收 / 排行 / 搜索 ----
const revenue = ref<Revenue | null>(null);
/** 排行榜自己的时间窗（30/90/365），和顶部 7/30/90 的整页范围解耦 */
const topDays = ref(30);
const topN = ref(10);
const TOP_N_OPTIONS = [5, 10, 20, 30];
const topLoading = ref(false);
const searchStats = ref<SearchStats | null>(null);
const searchLoading = ref(false);

const statCards = computed(() => {
  const o = overview.value;
  const ship = o?.toShip ?? 0;
  const low = o?.lowStockCount ?? 0;
  return [
    { label: '今日 GMV', value: o ? fenToYuan(o.today.gmv) : '—', unit: '元', tone: '' },
    { label: '今日销量', value: o?.today.salesCount ?? '—', unit: '件', tone: '' },
    { label: '今日订单', value: o?.today.orderCount ?? '—', unit: '单', tone: '' },
    { label: `近 ${days.value} 天 GMV`, value: o ? fenToYuan(o.week.gmv) : '—', unit: '元', tone: '' },
    // 待发货与低库存是「要动手」的指标，用琥珀色跳出来
    { label: '待发货', value: o?.toShip ?? '—', unit: '单', tone: ship > 0 ? 'warn' : '' },
    { label: '低库存', value: o?.lowStockCount ?? '—', unit: 'SKU', tone: low > 0 ? 'crit' : '' },
  ];
});

function levelText(level: Advice['level']) {
  return level === 'danger' ? '紧急' : level === 'warn' ? '关注' : '提示';
}

// ---- 图表实例 ----
const trendRef = ref<HTMLElement | null>(null);
const funnelRef = ref<HTMLElement | null>(null);
const topRef = ref<HTMLElement | null>(null);
const searchTrendRef = ref<HTMLElement | null>(null);
let trendChart: ECharts | null = null;
let funnelChart: ECharts | null = null;
let topChart: ECharts | null = null;
let searchChart: ECharts | null = null;

function renderTrend(points: TrendPoint[]) {
  if (!trendRef.value) return;
  if (!trendChart) trendChart = echarts.init(trendRef.value);
  const p = readPalette();
  const axis = axisCommon(p);
  trendChart.setOption(
    {
      tooltip: { trigger: 'axis', ...tooltipStyle(p), axisPointer: { lineStyle: { color: p.axis } } },
      legend: {
        data: ['GMV', '净额', '订单数'],
        right: 0,
        top: 0,
        itemWidth: 10,
        itemHeight: 2,
        itemGap: 16,
        textStyle: { color: p.textMid, fontSize: 10, fontFamily: MONO },
      },
      grid: { left: 52, right: 52, top: 44, bottom: 28 },
      xAxis: {
        type: 'category',
        data: points.map((pt) => pt.date.slice(5)),
        ...axis,
        axisLabel: { ...axis.axisLabel, interval: points.length > 20 ? 'auto' : 0 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'GMV',
          nameTextStyle: { color: p.axisLabel, fontSize: 10, fontFamily: MONO, align: 'right' },
          ...axis,
          splitLine: { lineStyle: { color: p.gridLine, type: 'dashed' } },
          axisLabel: {
            ...axis.axisLabel,
            formatter: (v: number) => (v >= 10000 ? `${v / 10000}w` : `${v}`),
          },
        },
        {
          type: 'value',
          name: '订单',
          nameTextStyle: { color: p.axisLabel, fontSize: 10, fontFamily: MONO },
          ...axis,
          minInterval: 1,
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'GMV',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          showSymbol: points.length <= 14,
          data: points.map((pt) => Number((pt.gmv / 100).toFixed(2))),
          lineStyle: { width: 2, color: p.signal },
          itemStyle: { color: p.signal },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: mix(p.signal, p.panel, 0.78) },
              { offset: 1, color: mix(p.signal, p.panel, 1) },
            ]),
          },
        },
        {
          name: '订单数',
          type: 'bar',
          yAxisIndex: 1,
          data: points.map((pt) => pt.orderCount),
          barMaxWidth: 10,
          // 次要序列用低饱和琥珀，避免抢走 GMV 主线的视觉重量；
          // 掺白/掺面板只到 28%，再淡就低于 3:1 看不清了
          itemStyle: { color: mix(p.amber, p.panel, 0.28) },
        },
        {
          // 净额永远在 GMV 之下，用蓝色虚线叠在上面不会互相遮；
          // 不画面积，避免和 GMV 的渐变糊成一片
          name: '净额',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 3,
          showSymbol: false,
          data: points.map((pt) => Number((pt.net / 100).toFixed(2))),
          lineStyle: { width: 1.5, type: 'dashed', color: p.blue },
          itemStyle: { color: p.blue },
        },
      ],
    },
    true
  );
}

function renderFunnel(data: FunnelData | null) {
  if (!funnelRef.value) return;
  if (!funnelChart) funnelChart = echarts.init(funnelRef.value);
  const p = readPalette();
  const stages = data?.stages ?? [];
  // 全 0 时漏斗会渲染成空白，给递减占位值保留图形轮廓（仅展示用）
  const hasData = stages.some((s) => s.value > 0);
  // 漏斗用信号色的明度阶梯（向面板色掺），比彩虹色更像仪表；
  // 字色逐级算，保证浅色主题下深色块配白字、浅色块配深字。
  const ramp = [0, 0.18, 0.36, 0.54, 0.72].map((t) => mix(p.signal, p.panel, t));
  funnelChart.setOption(
    {
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(p),
        formatter: (pt: unknown) => {
          const item = pt as { dataIndex: number };
          const s = stages[item.dataIndex];
          if (!s) return '';
          return `${s.label}<br/>会话 ${s.value}<br/>较首级 ${s.rate}%`;
        },
      },
      series: [
        {
          type: 'funnel',
          left: '4%',
          right: '4%',
          top: 8,
          bottom: 8,
          minSize: '24%',
          maxSize: '100%',
          sort: 'none',
          gap: 2,
          label: {
            show: true,
            position: 'inside',
            color: inkOn(ramp[0]),
            fontSize: 11,
            fontFamily: MONO,
            fontWeight: 600,
          },
          labelLine: { show: false },
          itemStyle: { borderColor: p.panel, borderWidth: 1 },
          data: stages.map((s, i) => {
            const bg = ramp[i % ramp.length];
            return {
              name: `${s.label} ${s.rate}%`,
              value: hasData ? s.value : Math.max(stages.length - i, 1),
              itemStyle: { color: bg },
              label: { color: inkOn(bg) },
            };
          }),
        },
      ],
    },
    true
  );
}

function renderTop(products: TopProduct[]) {
  if (!topRef.value) return;
  // 无数据时容器是 v-if 里的空态，有数据才挂载图表 dom；
  // 换过 dom 之后旧实例绑的是已脱离文档的 canvas，必须重建，否则点了没反应
  if (topChart && topChart.getDom() !== topRef.value) {
    topChart.dispose();
    topChart = null;
  }
  if (!topChart) {
    topChart = echarts.init(topRef.value);
    // 点柱子看单品趋势：榜单本身就是入口，不用再放一列「查看」
    topChart.on('click', (params) => {
      const idx = (params as { dataIndex?: number }).dataIndex;
      if (idx === undefined) return;
      const item = topProducts.value[idx];
      if (item) openProductTrend(item.productId);
    });
  }
  const p = readPalette();
  const axis = axisCommon(p);
  topChart.setOption(
    {
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(p),
        formatter: (params: unknown) => {
          const items = params as { dataIndex: number; marker: string; value: number }[];
          if (!items.length) return '';
          const pt = products[items[0].dataIndex];
          if (!pt) return '';
          return [
            `${items[0].marker}<b>${pt.name}</b>`,
            `销量：${pt.salesCount} 件`,
            `GMV：${fenToYuan(pt.gmv)} 元`,
            `订单：${pt.orderCount} 单`,
            `名次：TOP ${pt.rank}`,
          ].join('<br/>');
        },
      },
      grid: { left: 44, right: 16, top: 18, bottom: 52 },
      xAxis: {
        type: 'category',
        data: products.map((pt) => pt.name),
        ...axis,
        axisLabel: {
          ...axis.axisLabel,
          interval: products.length > 12 ? 'auto' : 0,
          rotate: 24,
          width: 84,
          overflow: 'truncate',
        },
      },
      yAxis: {
        type: 'value',
        ...axis,
        minInterval: 1,
        splitLine: { lineStyle: { color: p.gridLine, type: 'dashed' } },
      },
      series: [
        {
          type: 'bar',
          // 前三名用满色信号，其余掺面板色退到背景里，眼睛先落在头部
          data: products.map((pt, i) => ({
            value: pt.salesCount,
            itemStyle: { color: i < 3 ? p.signal : mix(p.signal, p.panel, 0.45) },
          })),
          barMaxWidth: 26,
          cursor: 'pointer',
        },
      ],
    },
    true
  );
}

function handleResize() {
  trendChart?.resize();
  funnelChart?.resize();
  topChart?.resize();
  searchChart?.resize();
  prodChart?.resize();
}

/* ------------------------------------------------ 搜索分析 */
/** 关键词条：按当前列表最大值归一，最短也留 4% 让 1 次的词有个可见的块 */
function kwWidth(count: number, kind: 'top' | 'zero'): string {
  const list = kind === 'top' ? searchStats.value?.topKeywords : searchStats.value?.zeroKeywords;
  const max = Math.max(...(list ?? []).map((k) => (kind === 'top' ? k.count : k.zeroCount)), 1);
  return `${Math.max(4, Math.round((count / max) * 100))}%`;
}

function renderSearchTrend(points: { date: string; count: number }[]) {
  if (!searchTrendRef.value) return;
  if (searchChart && searchChart.getDom() !== searchTrendRef.value) {
    searchChart.dispose();
    searchChart = null;
  }
  if (!searchChart) searchChart = echarts.init(searchTrendRef.value);
  const p = readPalette();
  const axis = axisCommon(p);
  searchChart.setOption(
    {
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(p),
        formatter: (params: unknown) => {
          const arr = params as { dataIndex: number; marker: string }[];
          const pt = points[arr[0]?.dataIndex ?? 0];
          return pt ? `${pt.date}<br/>${arr[0].marker}搜索 ${pt.count} 次` : '';
        },
      },
      // 迷你趋势图：不放坐标轴标题，只留日期刻度，省高度给下面的关键词榜
      grid: { left: 10, right: 10, top: 12, bottom: 20 },
      xAxis: {
        type: 'category',
        data: points.map((pt) => pt.date.slice(5)),
        ...axis,
        axisLabel: {
          ...axis.axisLabel,
          fontSize: 9,
          interval: Math.max(0, Math.ceil(points.length / 6) - 1),
        },
      },
      yAxis: { type: 'value', show: false, minInterval: 1 },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: points.map((pt) => pt.count),
          lineStyle: { width: 1.5, color: p.signal },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: mix(p.signal, p.panel, 0.7) },
              { offset: 1, color: mix(p.signal, p.panel, 1) },
            ]),
          },
        },
      ],
    },
    true
  );
}

/* ------------------------------------------------ 单品售卖趋势 */
const prodVisible = ref(false);
const prodLoading = ref(false);
const prodTrend = ref<ProductTrend | null>(null);
const prodDays = ref(30);
const prodChartRef = ref<HTMLElement | null>(null);
let prodChart: ECharts | null = null;

/** 日均销量：窗口长短不同时也能横向比；小店铺一年卖几件，一位小数会全变成 0.0 */
const prodDaily = computed(() => {
  const t = prodTrend.value;
  if (!t || !t.days) return '—';
  const v = t.totalSales / t.days;
  return v >= 0.1 ? v.toFixed(1) : v.toFixed(2);
});

async function openProductTrend(productId: number) {
  prodVisible.value = true;
  // 默认跟榜单同一个窗口，商家看到的就是刚才那根柱子的明细
  prodDays.value = topDays.value;
  prodTrend.value = null;
  await loadProdTrend(productId);
}

async function loadProdTrend(productId?: number) {
  const id = productId ?? prodTrend.value?.productId;
  if (!id) return;
  prodLoading.value = true;
  try {
    const t = await adminProductTrend(id, Number(prodDays.value));
    prodTrend.value = t;
    await nextTick();
    renderProdTrend(t);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载单品趋势失败');
  } finally {
    prodLoading.value = false;
  }
}

function renderProdTrend(t: ProductTrend) {
  if (!prodChartRef.value) return;
  if (prodChart && prodChart.getDom() !== prodChartRef.value) {
    prodChart.dispose();
    prodChart = null;
  }
  if (!prodChart) prodChart = echarts.init(prodChartRef.value);
  const p = readPalette();
  const axis = axisCommon(p);
  prodChart.setOption(
    {
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(p),
        formatter: (params: unknown) => {
          const arr = params as { dataIndex: number }[];
          const pt = t.points[arr[0]?.dataIndex ?? 0];
          if (!pt) return '';
          return [
            `<b>${pt.date}</b>`,
            `销量：${pt.salesCount} 件`,
            `GMV：${fenToYuan(pt.gmv)} 元`,
            `订单：${pt.orderCount} 单`,
          ].join('<br/>');
        },
      },
      legend: {
        data: ['销量', 'GMV'],
        right: 0,
        top: 0,
        itemWidth: 10,
        itemHeight: 2,
        itemGap: 14,
        textStyle: { color: p.textMid, fontSize: 10, fontFamily: MONO },
      },
      grid: { left: 46, right: 54, top: 40, bottom: 28 },
      xAxis: {
        type: 'category',
        data: t.points.map((pt) => pt.date.slice(5)),
        ...axis,
        axisLabel: { ...axis.axisLabel, interval: t.points.length > 20 ? 'auto' : 0 },
      },
      yAxis: [
        {
          type: 'value',
          name: '件',
          nameTextStyle: { color: p.axisLabel, fontSize: 10, fontFamily: MONO, align: 'right' },
          ...axis,
          minInterval: 1,
          splitLine: { lineStyle: { color: p.gridLine, type: 'dashed' } },
        },
        {
          type: 'value',
          name: '元',
          nameTextStyle: { color: p.axisLabel, fontSize: 10, fontFamily: MONO },
          ...axis,
          splitLine: { show: false },
          axisLabel: {
            ...axis.axisLabel,
            formatter: (v: number) => (v >= 10000 ? `${v / 10000}w` : `${v}`),
          },
        },
      ],
      series: [
        {
          name: '销量',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          showSymbol: t.points.length <= 14,
          data: t.points.map((pt) => pt.salesCount),
          lineStyle: { width: 2, color: p.signal },
          itemStyle: { color: p.signal },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: mix(p.signal, p.panel, 0.78) },
              { offset: 1, color: mix(p.signal, p.panel, 1) },
            ]),
          },
        },
        {
          name: 'GMV',
          type: 'bar',
          yAxisIndex: 1,
          data: t.points.map((pt) => Number((pt.gmv / 100).toFixed(2))),
          barMaxWidth: 10,
          itemStyle: { color: mix(p.amber, p.panel, 0.28) },
        },
      ],
    },
    true
  );
}

/* ------------------------------------------------ 用户搜索流水 */
const logsVisible = ref(false);
const logsLoading = ref(false);
const logs = ref<SearchLogRow[]>([]);
const logsTitle = ref('搜索记录');

async function openUserLogs(row: SearchUserRow) {
  logsTitle.value = `${row.nickname || '微信用户'} 的搜索记录`;
  logs.value = [];
  logsVisible.value = true;
  logsLoading.value = true;
  try {
    const page = await adminSearchLogs({ days: Number(days.value), userId: row.userId, size: 50 });
    logs.value = page.list;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载搜索记录失败');
  } finally {
    logsLoading.value = false;
  }
}

const formatTime = (t: string) => new Date(t).toLocaleString('zh-CN', { hour12: false });

/* ------------------------------------------------ 加载 */
/** 排行榜单独加载：切 30/90/365 或 TOP N 时只重画这一块，不动整页 */
async function loadTop() {
  topLoading.value = true;
  try {
    const tp = await adminTopProducts({ days: Number(topDays.value), limit: Number(topN.value) });
    topProducts.value = tp;
    await nextTick();
    renderTop(tp);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载排行榜失败');
  } finally {
    topLoading.value = false;
  }
}

async function load() {
  loading.value = true;
  searchLoading.value = true;
  try {
    const d = Number(days.value);
    const [o, tr, fn, ad, ls] = await Promise.all([
      adminOverview(),
      adminTrend(d),
      adminFunnel(d),
      adminAdvice(d),
      adminLowStock(10),
    ]);
    overview.value = o;
    trend.value = tr;
    funnel.value = fn;
    advice.value = ad;
    lowStock.value = ls;
    updatedText.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    await nextTick();
    renderTrend(tr);
    renderFunnel(fn);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }

  // 营收与搜索是两块新接口：单独兜住失败，别让其中一个拖垮整个大盘
  const d = Number(days.value);
  const [rev, se] = await Promise.all([
    adminRevenue(d).catch(() => null),
    adminSearchStats(d).catch(() => null),
  ]);
  revenue.value = rev;
  searchStats.value = se;
  searchLoading.value = false;
  await nextTick();
  if (se) renderSearchTrend(se.trend);

  void loadTop();
}

onMounted(() => {
  window.addEventListener('resize', handleResize);
  load();
});

// 切主题时 canvas 不会自动重画，得用当前数据按新色板重渲染一遍
watch(
  () => theme.mode,
  () => {
    nextTick(() => {
      renderTrend(trend.value);
      renderFunnel(funnel.value);
      renderTop(topProducts.value);
      if (searchStats.value) renderSearchTrend(searchStats.value.trend);
      if (prodTrend.value) renderProdTrend(prodTrend.value);
    });
  }
);

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  trendChart?.dispose();
  funnelChart?.dispose();
  topChart?.dispose();
  searchChart?.dispose();
  prodChart?.dispose();
  trendChart = null;
  funnelChart = null;
  topChart = null;
  searchChart = null;
  prodChart = null;
});
</script>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stamp {
  font-size: 10.5px;
  color: var(--text-lo);
  letter-spacing: 0.06em;
}

/* ─────────── 仪表读数条 ─────────── */
.kpi-panel {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.kpi {
  padding: 14px 16px 15px;
  border-right: 1px solid var(--line-1);
  min-width: 0;
}
.kpi:last-child {
  border-right: none;
}
.kpi-val {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-top: 8px;
}
.kpi-val .num {
  font-size: 24px;
  font-weight: 500;
  line-height: 1.1;
  color: var(--text-hi);
}
.unit {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-lo);
}
.kpi.warn .kpi-val .num {
  color: var(--amber);
}
.kpi.crit .kpi-val .num {
  color: var(--red);
}

/* ─────────── 栅格 ─────────── */
.grid {
  display: grid;
  gap: 12px;
}
.cols-2-1 {
  grid-template-columns: minmax(0, 1.95fr) minmax(0, 1fr);
}

.chart {
  height: 320px;
}
.chart-sm {
  height: 288px;
}

.empty {
  padding: 22px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-lo);
}

.worst {
  margin-top: 8px;
  padding: 7px 10px;
  border: 1px solid var(--amber-border);
  background: var(--amber-soft);
  color: var(--amber);
  font-size: 11px;
  text-align: center;
  letter-spacing: 0.02em;
}
.worst strong {
  font-weight: 600;
  margin-left: 2px;
}

/* ─────────── 经营建议：像运维日志 ─────────── */
.advice-bd {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0;
}
.advice {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 16px;
  border-left: 2px solid var(--line-2);
  background: transparent;
  transition: background var(--dur-1) var(--ease);
}
.advice:hover {
  background: rgba(233, 241, 245, 0.02);
}
.advice.info {
  border-left-color: var(--blue);
}
.advice.warn {
  border-left-color: var(--amber);
}
.advice.danger {
  border-left-color: var(--red);
}
.advice-tag {
  flex: none;
  margin-top: 1px;
  padding: 1px 6px;
  border: 1px solid var(--line-2);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--text-lo);
}
.advice.info .advice-tag {
  color: var(--blue);
  border-color: var(--blue-border);
}
.advice.warn .advice-tag {
  color: var(--amber);
  border-color: var(--amber-border);
}
.advice.danger .advice-tag {
  color: var(--red);
  border-color: var(--red-border);
}
.advice-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-hi);
  margin-bottom: 3px;
}
.advice-detail {
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-mid);
}

/* ─────────── 低库存 ─────────── */
.lowstock-bd {
  padding: 0;
}
.lowstock-bd .el-table {
  --el-table-border-color: var(--line-1);
}
.prod {
  line-height: 1.3;
}
.stock {
  font-size: 13px;
}
.stock.warn {
  color: var(--amber);
}
.stock.crit {
  color: var(--red);
  font-weight: 600;
}
.lowstock-more {
  display: block;
  margin-top: 8px;
  padding: 0 14px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-lo);
  text-decoration: none;
}
.lowstock-more:hover {
  color: var(--signal);
}

/* ─────────── 营收口径：一条算式 ─────────── */
.rev-bd {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  padding: 0;
}
.rev-eq {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  padding: 16px;
  min-width: 0;
}
.rev-cell {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 6px;
}
.rev-num {
  margin-top: 7px;
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 500;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.rev-num.neg {
  color: var(--text-mid);
}
.rev-cell.net .rev-num {
  color: var(--signal);
  font-weight: 600;
}
.rev-sub {
  margin-top: 4px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-lo);
}
.rev-op {
  flex: none;
  align-self: center;
  padding: 0 2px;
  font-family: var(--font-mono);
  font-size: 15px;
  color: var(--line-3);
}
.rev-op.eq {
  color: var(--signal);
  font-weight: 600;
}
.rev-meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 7px;
  padding: 14px 16px;
  border-left: 1px solid var(--line-1);
}
.rev-meta-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.rev-meta-row b {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.rev-warn {
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--amber);
}
.rev-ok {
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-lo);
}
.rev-link {
  color: var(--signal);
  text-decoration: none;
  white-space: nowrap;
}
.rev-link:hover {
  text-decoration: underline;
}

/* ─────────── 面板头部控件 ─────────── */
.hd-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.n-select {
  width: 94px;
}
.chart-hint {
  margin-top: 6px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-lo);
  text-align: right;
}
.chart-xs {
  height: 96px;
}
.chart-md {
  height: 300px;
}

/* ─────────── 搜索分析 ─────────── */
.search-bd {
  padding: 0;
}
.search-top {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  border-bottom: 1px solid var(--line-1);
}
.search-kpi {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-right: 1px solid var(--line-1);
}
.sk {
  padding: 14px 16px;
  border-right: 1px solid var(--line-1);
  min-width: 0;
}
.sk:last-child {
  border-right: none;
}
.sk-num {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 500;
  line-height: 1.15;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.sk-sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--text-lo);
}
.sk.warn .sk-num {
  color: var(--amber);
}
.search-chart {
  padding: 6px 12px 2px;
  min-width: 0;
}
.search-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.kw-col {
  padding: 12px 16px 14px;
  min-width: 0;
}
.kw-col + .kw-col {
  border-left: 1px solid var(--line-1);
}
.kw-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.kw-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 132px 44px;
  align-items: center;
  gap: 10px;
  height: 26px;
}
.kw-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12.5px;
  color: var(--text-mid);
}
.kw-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--line-1);
  overflow: hidden;
}
.kw-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--signal);
  transition: width var(--dur-2) var(--ease);
}
.kw-row.zero .kw-bar i {
  background: var(--amber);
}
.kw-num {
  font-size: 11.5px;
  text-align: right;
  color: var(--text-mid);
  font-variant-numeric: tabular-nums;
}
.user-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 16px;
  border-top: 1px solid var(--line-1);
}
.uid {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kw-last {
  font-size: 12.5px;
  color: var(--text-hi);
}
.zero-num {
  color: var(--red);
}

/* ─────────── 单品趋势抽屉 ─────────── */
.prod-drawer {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.prod-hd {
  display: flex;
  align-items: center;
  gap: 12px;
}
.prod-cover {
  width: 56px;
  height: 56px;
  flex: none;
  border-radius: var(--r-1);
  border: 1px solid var(--line-1);
}
.prod-cover.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: var(--line-3);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-lo);
}
.prod-note {
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-lo);
}
.prod-name {
  margin-bottom: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-hi);
}
.prod-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}
.prod-kpi {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
}
.pk {
  padding: 10px 12px;
  border-right: 1px solid var(--line-1);
  min-width: 0;
}
.pk:last-child {
  border-right: none;
}
.pk .sk-num {
  font-size: 17px;
}
.prod-range {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

@media (max-width: 1280px) {
  .kpi-panel {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .kpi:nth-child(3n) {
    border-right: none;
  }
  .kpi:nth-child(-n + 3) {
    border-bottom: 1px solid var(--line-1);
  }
  .cols-2-1 {
    grid-template-columns: minmax(0, 1fr);
  }
  /* 窄屏：算式折成 2×2，右侧小指标横排到下面 */
  .rev-bd {
    grid-template-columns: minmax(0, 1fr);
  }
  .rev-eq {
    flex-wrap: wrap;
    row-gap: 14px;
  }
  .rev-cell {
    flex: 1 1 38%;
  }
  .rev-op {
    display: none;
  }
  .rev-meta {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 8px 22px;
    border-left: none;
    border-top: 1px solid var(--line-1);
  }
  .search-top {
    grid-template-columns: minmax(0, 1fr);
  }
  .search-kpi {
    border-right: none;
    border-bottom: 1px solid var(--line-1);
  }
}
/* ─────────── 手机（≤900px）：一屏放不下并排，全部改上下 ─────────── */
@media (max-width: 900px) {
  /* 六格读数在手机上 3 列会挤成一团，改 2 列 × 3 行 */
  .kpi-panel {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .kpi {
    padding: 11px 12px 12px;
    border-right: 1px solid var(--line-1);
    border-bottom: 1px solid var(--line-1);
  }
  .kpi:nth-child(2n) {
    border-right: none;
  }
  .kpi:nth-last-child(-n + 2) {
    border-bottom: none;
  }
  .kpi-val .num {
    font-size: 20px;
  }
  /* 搜索分析：3 格读数压成一行，榜单与搜索用户上下排 */
  .search-kpi {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .search-cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .kw-row {
    grid-template-columns: minmax(0, 1fr) 84px 38px;
    gap: 8px;
  }
  /* 单品趋势抽屉里的 4 格读数改 2×2 */
  .prod-kpi {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .pk:nth-child(2n) {
    border-right: none;
  }
  .pk:nth-child(-n + 2) {
    border-bottom: 1px solid var(--line-1);
  }
  .prod-hd {
    gap: 10px;
  }
  .prod-cover {
    width: 46px;
    height: 46px;
  }
  /* 表格列多，手机上让表头吸顶后仍能看清分组 */
  .lowstock-more {
    display: block;
    padding: 8px 0;
  }
}
</style>
