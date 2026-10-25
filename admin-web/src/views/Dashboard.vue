<template>
  <div class="dashboard" v-loading="loading">
    <!-- 顶部：时间范围 + 刷新 -->
    <div class="toolbar">
      <el-radio-group v-model="days" size="small" @change="load">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
        <el-radio-button :value="90">近 90 天</el-radio-button>
      </el-radio-group>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <!-- 统计卡片 -->
    <el-row :gutter="16" class="cards">
      <el-col v-for="card in statCards" :key="card.label" :span="4">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-label">{{ card.label }}</div>
          <div class="stat-value">{{ card.value }}</div>
          <div class="stat-unit">{{ card.unit }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 趋势图 + 转化漏斗 -->
    <el-row :gutter="16">
      <el-col :span="16">
        <el-card shadow="never" class="panel">
          <template #header>
            <div class="panel-head">
              <span>近 {{ days }} 天经营趋势</span>
              <span class="legend-hint">GMV（元）· 订单数（单）</span>
            </div>
          </template>
          <div ref="trendRef" class="chart" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" class="panel">
          <template #header>转化漏斗（去重会话）</template>
          <div ref="funnelRef" class="chart" />
          <div v-if="funnel && funnel.worst" class="funnel-worst">
            最大流失：{{ funnel.worst.from }} → {{ funnel.worst.to }}
            <strong>{{ funnel.worst.dropRate }}%</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 经营建议 -->
    <el-card shadow="never" class="panel">
      <template #header>经营建议</template>
      <div v-if="advice.length === 0" class="empty">
        暂无建议 —— 当前各项指标均在健康区间
      </div>
      <div v-else class="advice-list">
        <div v-for="(a, i) in advice" :key="i" class="advice-item" :class="a.level">
          <span class="badge">{{ levelText(a.level) }}</span>
          <div class="advice-body">
            <div class="advice-title">{{ a.title }}</div>
            <div class="advice-detail">{{ a.detail }}</div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- TOP 商品 + 低库存 -->
    <el-row :gutter="16">
      <el-col :span="16">
        <el-card shadow="never" class="panel">
          <template #header>近 {{ days }} 天商品销量 TOP {{ topProducts.length || 10 }}</template>
          <div ref="topRef" class="chart chart-sm" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" class="panel">
          <template #header>低库存预警（库存 ≤ 10）</template>
          <div v-if="lowStock.length === 0" class="empty">暂无低库存商品</div>
          <el-table v-else :data="lowStock" size="small" border>
            <el-table-column label="商品" min-width="120">
              <template #default="{ row }">
                <div class="prod">{{ row.productName }}</div>
                <div class="muted">{{ row.specName }}</div>
              </template>
            </el-table-column>
            <el-table-column label="库存" width="80" align="right">
              <template #default="{ row }">
                <el-tag :type="row.stock <= 5 ? 'danger' : 'warning'" size="small">{{ row.stock }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, FunnelChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import { ElMessage } from 'element-plus';
import {
  adminAdvice,
  adminFunnel,
  adminLowStock,
  adminOverview,
  adminTopProducts,
  adminTrend,
  type Advice,
  type FunnelData,
  type LowStockSku,
  type Overview,
  type TopProduct,
  type TrendPoint,
} from '@/api/stats';
import { fenToYuan } from '@/utils/money';

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

// 品牌色（与小程序设计系统一致）
const BRAND = '#ff6b35';
const FUNNEL_COLORS = ['#ff6b35', '#ff8f3c', '#ffa96b', '#ffc59b', '#ffdcc8'];

const loading = ref(false);
const days = ref(30);
const overview = ref<Overview | null>(null);
const trend = ref<TrendPoint[]>([]);
const funnel = ref<FunnelData | null>(null);
const advice = ref<Advice[]>([]);
const topProducts = ref<TopProduct[]>([]);
const lowStock = ref<LowStockSku[]>([]);

const statCards = computed(() => {
  const o = overview.value;
  return [
    { label: '今日 GMV', value: o ? fenToYuan(o.today.gmv) : '—', unit: '元' },
    { label: '今日销量', value: o?.today.salesCount ?? '—', unit: '件' },
    { label: '今日订单', value: o?.today.orderCount ?? '—', unit: '单' },
    { label: `近 ${days.value} 天 GMV`, value: o ? fenToYuan(o.week.gmv) : '—', unit: '元' },
    { label: '待发货', value: o?.toShip ?? '—', unit: '单' },
    { label: '低库存预警', value: o?.lowStockCount ?? '—', unit: '个 SKU' },
  ];
});

function levelText(level: Advice['level']) {
  return level === 'danger' ? '紧急' : level === 'warn' ? '关注' : '提示';
}

// ---- 图表实例 ----
const trendRef = ref<HTMLElement | null>(null);
const funnelRef = ref<HTMLElement | null>(null);
const topRef = ref<HTMLElement | null>(null);
let trendChart: ECharts | null = null;
let funnelChart: ECharts | null = null;
let topChart: ECharts | null = null;

function renderTrend(points: TrendPoint[]) {
  if (!trendRef.value) return;
  if (!trendChart) trendChart = echarts.init(trendRef.value);
  trendChart.setOption(
    {
      tooltip: { trigger: 'axis' },
      legend: { data: ['GMV', '订单数'], right: 0, top: 0, itemWidth: 12, itemHeight: 8 },
      grid: { left: 56, right: 56, top: 40, bottom: 32 },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.date.slice(5)), // MM-DD
        axisLabel: { interval: points.length > 20 ? 'auto' : 0 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'GMV(元)',
          splitLine: { lineStyle: { type: 'dashed' } },
          axisLabel: {
            formatter: (v: number) => (v >= 10000 ? `${v / 10000}w` : `${v}`),
          },
        },
        { type: 'value', name: '订单(单)', minInterval: 1, splitLine: { show: false } },
      ],
      series: [
        {
          name: 'GMV',
          type: 'line',
          smooth: true,
          showSymbol: points.length <= 14,
          data: points.map((p) => Number((p.gmv / 100).toFixed(2))),
          lineStyle: { width: 2.5, color: BRAND },
          itemStyle: { color: BRAND },
          areaStyle: { color: 'rgba(255,107,53,0.12)' },
        },
        {
          name: '订单数',
          type: 'bar',
          yAxisIndex: 1,
          data: points.map((p) => p.orderCount),
          barMaxWidth: 18,
          itemStyle: { color: BRAND, borderRadius: [3, 3, 0, 0], opacity: 0.65 },
        },
      ],
    },
    true
  );
}

function renderFunnel(data: FunnelData | null) {
  if (!funnelRef.value) return;
  if (!funnelChart) funnelChart = echarts.init(funnelRef.value);
  const stages = data?.stages ?? [];
  // 全 0 时漏斗会渲染成空白，给递减占位值保留图形轮廓（仅展示用）
  const hasData = stages.some((s) => s.value > 0);
  funnelChart.setOption(
    {
      tooltip: {
        trigger: 'item',
        formatter: (p: unknown) => {
          const item = p as { dataIndex: number };
          const s = stages[item.dataIndex];
          if (!s) return '';
          return `${s.label}<br/>会话数：${s.value}<br/>较首级：${s.rate}%`;
        },
      },
      series: [
        {
          type: 'funnel',
          left: '6%',
          right: '6%',
          top: 12,
          bottom: 12,
          minSize: '22%',
          maxSize: '100%',
          sort: 'none',
          gap: 3,
          label: { show: true, position: 'inside', color: '#fff', fontSize: 12 },
          labelLine: { show: false },
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          data: stages.map((s, i) => ({
            name: `${s.label} ${s.rate}%`,
            value: hasData ? s.value : Math.max(stages.length - i, 1),
            itemStyle: { color: FUNNEL_COLORS[i % FUNNEL_COLORS.length] },
          })),
        },
      ],
    },
    true
  );
}

function renderTop(products: TopProduct[]) {
  if (!topRef.value) return;
  if (!topChart) topChart = echarts.init(topRef.value);
  topChart.setOption(
    {
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const items = params as { name: string; value: number; marker: string }[];
          if (!items.length) return '';
          const p = products.find((x) => x.name === items[0].name);
          return items
            .map((i) => `${i.marker}${i.name}：${i.value} 件`)
            .concat(p ? [`GMV：${fenToYuan(p.gmv)} 元`] : [])
            .join('<br/>');
        },
      },
      grid: { left: 48, right: 24, top: 24, bottom: 48 },
      xAxis: {
        type: 'category',
        data: products.map((p) => p.name),
        axisLabel: { interval: 0, rotate: 20, width: 90, overflow: 'truncate' },
      },
      yAxis: { type: 'value', name: '销量（件）', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: products.map((p) => p.salesCount),
          barMaxWidth: 36,
          itemStyle: { color: BRAND, borderRadius: [3, 3, 0, 0] },
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
}

async function load() {
  loading.value = true;
  try {
    const d = Number(days.value);
    const [o, tr, fn, ad, tp, ls] = await Promise.all([
      adminOverview(),
      adminTrend(d),
      adminFunnel(d),
      adminAdvice(d),
      adminTopProducts({ days: d, limit: 10 }),
      adminLowStock(10),
    ]);
    overview.value = o;
    trend.value = tr;
    funnel.value = fn;
    advice.value = ad;
    topProducts.value = tp;
    lowStock.value = ls;
    await nextTick();
    renderTrend(tr);
    renderFunnel(fn);
    renderTop(tp);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  window.addEventListener('resize', handleResize);
  load();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  trendChart?.dispose();
  funnelChart?.dispose();
  topChart?.dispose();
  trendChart = null;
  funnelChart = null;
  topChart = null;
});
</script>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.cards {
  margin-bottom: 16px;
}
.stat-card .stat-label {
  color: #909399;
  font-size: 13px;
}
.stat-value {
  font-size: 24px;
  font-weight: 600;
  margin-top: 6px;
  line-height: 1.2;
  color: #1f2d3d;
}
.stat-unit {
  color: #c0c4cc;
  font-size: 12px;
  margin-top: 2px;
}
.panel {
  margin-bottom: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.legend-hint {
  font-size: 12px;
  color: #c0c4cc;
  font-weight: 400;
}
.chart {
  height: 340px;
}
.chart-sm {
  height: 300px;
}
.empty {
  color: #c0c4cc;
  text-align: center;
  padding: 24px 0;
}
.prod {
  line-height: 1.3;
}
.muted {
  color: #909399;
  font-size: 12px;
}
.funnel-worst {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff7ed;
  color: #b45309;
  font-size: 12px;
  text-align: center;
}
.funnel-worst strong {
  color: #ea580c;
}
/* 经营建议 */
.advice-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.advice-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: 10px;
  border-left: 3px solid #dcdfe6;
  background: #fafafa;
}
.advice-item.info {
  border-left-color: #409eff;
  background: #f4f9ff;
}
.advice-item.warn {
  border-left-color: #ff8f3c;
  background: #fff8f2;
}
.advice-item.danger {
  border-left-color: #f56c6c;
  background: #fef4f4;
}
.badge {
  flex: none;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  color: #fff;
  background: #909399;
}
.advice-item.info .badge {
  background: #409eff;
}
.advice-item.warn .badge {
  background: #ff8f3c;
}
.advice-item.danger .badge {
  background: #f56c6c;
}
.advice-title {
  font-weight: 600;
  font-size: 14px;
  color: #1f2d3d;
  margin-bottom: 2px;
}
.advice-detail {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
}
</style>
