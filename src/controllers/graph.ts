import {
  defaults,
  Chart,
  ScatterController,
  clipArea,
  unclipArea,
  registry,
  merge,
  LineController,
  LinearScale,
  Point,
  UpdateMode,
  ITooltipItem,
  IChartMeta,
} from 'chart.js';
// not part of facade since not part of UMD build
import { listenArrayEvents, unlistenArrayEvents } from 'chart.js/helpers/collection';
import { EdgeLine } from '../elements';
import { interpolatePoints } from './utils';
import patchController from './patchController';

interface IExtendedChartMeta extends IChartMeta{
  _parsedEdges: { source: Point, target: Point, points: { x: number, y: number }[] }[];
}

export class GraphController extends ScatterController {
  declare _cachedMeta: IExtendedChartMeta;
  declare _ctx: CanvasRenderingContext2D;

  private _scheduleResyncLayoutId = -1;
  private _cachedEdgeOpts = {};
  edgeElementOptions: any;
  edgeElementType: any;

  private readonly _edgeListener = {
    _onDataPush: (...args: any[]) => {
      const count = args.length;
      const start = this.getDataset().edges.length - count;
      const parsed = this._cachedMeta._parsedEdges;
      args.forEach((edge) => {
        parsed.push(this._parseDefinedEdge(edge));
      });
      this._insertEdgeElements(start, count);
    },
    _onDataPop: () => {
      this._cachedMeta.edges.pop();
      this._cachedMeta._parsedEdges.pop();
      this._scheduleResyncLayout();
    },
    _onDataShift: () => {
      this._cachedMeta.edges.shift();
      this._cachedMeta._parsedEdges.shift();
      this._scheduleResyncLayout();
    },
    _onDataSplice: (start: number, count: number, ...args: any[]) => {
      this._cachedMeta.edges.splice(start, count);
      this._cachedMeta._parsedEdges.splice(start, count);
      if (args.length > 0) {
        const parsed = this._cachedMeta._parsedEdges;
        parsed.splice(start, 0, ...args.map((edge) => this._parseDefinedEdge(edge)));
        this._insertEdgeElements(start, args.length);
      } else {
        this._scheduleResyncLayout();
      }
    },
    _onDataUnshift: (...args: any[]) => {
      const parsed = this._cachedMeta._parsedEdges;
      parsed.unshift(...args.map((edge) => this._parseDefinedEdge(edge)));
      this._insertEdgeElements(0, args.length);
    },
  };

  initialize() {
    const type = this._type;
    const defaultConfig = defaults.get(type);
    this.edgeElementOptions = defaultConfig.edgeElementOptions;
    this.edgeElementType = registry.getElement(defaultConfig.edgeElementType);
    super.initialize();
    this._scheduleResyncLayout();
  }

  parse(start: number, count: number) {
    const meta = this._cachedMeta;
    const data = this._data;
    const iScale = meta.iScale;
    const vScale = meta.vScale;
    for (let i = 0; i < count; i++) {
      const index = i + start;
      const d = data[index];
      const v = meta._parsed[index] || {};
      if (d && typeof d.x === 'number') {
        v.x = d.x;
      }
      if (d && typeof d.y === 'number') {
        v.y = d.y;
      }
      meta._parsed[index] = v;
    }
    if (meta._parsed.length > data.length) {
      meta._parsed.splice(data.length, meta._parsed.length - data.length);
    }
    this._cachedMeta._sorted = false;
    iScale.invalidateCaches();
    vScale.invalidateCaches();

    this._parseEdges();
  }

  reset() {
    this.resetLayout();
    super.reset();
  }

  update(mode: UpdateMode) {
    super.update(mode);

    const meta = this._cachedMeta;
    const edges = meta.edges || [];

    this.updateEdgeElements(edges, 0, mode);
  }

  destroy() {
    super.destroy();
    if (this._edges) {
      unlistenArrayEvents(this._edges, this._edgeListener);
    }
    this.stopLayout();
  }

  updateEdgeElements(edges, start: number, mode: UpdateMode) {
    const bak = {
      _cachedDataOpts: this._cachedDataOpts,
      dataElementType: this.dataElementType,
      dataElementOptions: this.dataElementOptions,
      _sharedOptions: this._sharedOptions,
    };
    this._cachedDataOpts = {};
    this.dataElementType = this.edgeElementType;
    this.dataElementOptions = this.edgeElementOptions;
    const meta = this._cachedMeta;
    const nodes = meta.data;
    const data = meta._parsedEdges;

    const reset = mode === 'reset';

    const firstOpts = this.resolveDataElementOptions(start, mode);
    const sharedOptions = this.getSharedOptions(mode || 'normal', edges[start], firstOpts);
    const includeOptions = this.includeOptions(mode, sharedOptions);

    const xScale = meta.xScale!;
    const yScale = meta.yScale!;

    const base = {
      x: xScale.getBasePixel(),
      y: yScale.getBasePixel(),
    };

    function copyPoint(point: { x: number; y: number; angle: number }) {
      const x = reset ? base.x : xScale.getPixelForValue(point.x, 0);
      const y = reset ? base.y : yScale.getPixelForValue(point.y, 0);
      return {
        x,
        y,
        angle: point.angle,
      };
    }

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const index = start + i;
      const parsed = data[index];

      const properties = {
        source: nodes[parsed.source],
        target: nodes[parsed.target],
        points: Array.isArray(parsed.points) ? parsed.points.map(copyPoint) : [],
      };
      properties.points._source = nodes[parsed.source];
      if (includeOptions) {
        properties.options = this.resolveDataElementOptions(index, mode);
      }
      this.updateEdgeElement(edge, index, properties, mode);
    }
    this.updateSharedOptions(sharedOptions, mode);

    Object.assign(this, bak);
  }

  updateEdgeElement(edge, index: number, properties: any, mode: UpdateMode) {
    super.updateElement(edge, index, properties, mode);
  }

  updateElement(point, index: number, properties: any, mode: UpdateMode) {
    if (mode === 'reset') {
      // start in center also in x
      const xScale = this._cachedMeta.xScale;
      properties.x = xScale.getBasePixel();
    }
    super.updateElement(point, index, properties, mode);
  }

  resolveNodeIndex(nodes, ref: string | number | any) {
    if (typeof ref === 'number') {
      // index
      return ref;
    }
    if (typeof ref === 'string') {
      // label
      const labels = this.chart.data.labels;
      return labels.indexOf(ref);
    }
    const nIndex = nodes.indexOf(ref);
    if (nIndex >= 0) {
      // hit
      return nIndex;
    }

    if (ref && typeof ref.index === 'number') {
      return ref.index;
    }

    const data = this.getDataset().data;
    const index = data.indexOf(ref);
    if (index >= 0) {
      return index;
    }

    console.warn('cannot resolve edge ref', ref);
    return -1;
  }

  buildOrUpdateElements() {
    const dataset = this.getDataset();
    const edges = dataset.edges || [];

    // In order to correctly handle data addition/deletion animation (an thus simulate
    // real-time charts), we need to monitor these data modifications and synchronize
    // the internal meta data accordingly.
    if (this._edges !== edges) {
      if (this._edges) {
        // This case happens when the user replaced the data array instance.
        unlistenArrayEvents(this._edges, this._edgeListener);
      }

      if (edges && Object.isExtensible(edges)) {
        listenArrayEvents(edges, this._edgeListener);
      }
      this._edges = edges;
    }
    super.buildOrUpdateElements();
  }

  draw() {
    const meta = this._cachedMeta;
    const edges = meta.edges || [];
    const elements = meta.data || [];

    const area = this.chart.chartArea;
    const ctx = this._ctx;

    if (edges.length > 0) {
      clipArea(ctx, area);
      edges.forEach((edge) => edge.draw(ctx, area));
      unclipArea(ctx);
    }

    elements.forEach((elem) => elem.draw(ctx, area));
  }

  _resyncElements() {
    super._resyncElements();

    const meta = this._cachedMeta;
    const edges = meta._parsedEdges;
    const metaEdges = meta.edges || (meta.edges = []);
    const numMeta = metaEdges.length;
    const numData = edges.length;

    if (numData < numMeta) {
      metaEdges.splice(numData, numMeta - numData);
      this._scheduleResyncLayout();
    } else if (numData > numMeta) {
      this._insertEdgeElements(numMeta, numData - numMeta);
    }
  }

  getTreeRootIndex() {
    const ds = this.getDataset();
    const nodes = ds.data;
    if (ds.derivedEdges) {
      // find the one with no parent
      return nodes.findIndex((d) => d.parent == null);
    }
    // find the one with no edge
    const edges = this._cachedMeta._parsedEdges || [];
    const nodeIndices = new Set(nodes.map((_, i) => i));
    edges.forEach((edge) => {
      nodeIndices.delete(edge.targetIndex);
    });
    return Array.from(nodeIndices)[0];
  }

  getTreeRoot() {
    const index = this.getTreeRootIndex();
    const p = this.getParsed(index);
    p.index = index;
    return p;
  }

  getTreeChildren(node) {
    const edges = this._cachedMeta._parsedEdges;
    return edges
      .filter((d) => d.source === node.index)
      .map((d) => {
        const p = this.getParsed(d.target);
        p.index = d.target;
        return p;
      });
  }

  _parseDefinedEdge(edge) {
    const ds = this.getDataset();
    const data = ds.data;
    return {
      source: this.resolveNodeIndex(data, edge.source),
      target: this.resolveNodeIndex(data, edge.target),
      points: [],
    };
  }

  _parseEdges() {
    const ds = this.getDataset();
    const data = ds.data;
    const meta = this._cachedMeta;
    if (ds.edges) {
      return (meta._parsedEdges = ds.edges.map((edge) => this._parseDefinedEdge(edge)));
    }

    const edges = (meta._parsedEdges = []);
    // try to derive edges via parent links
    data.forEach((node, i) => {
      if (node.parent != null) {
        // tree edge
        const parent = this.resolveNodeIndex(data, node.parent);
        edges.push({
          source: parent,
          target: i,
          points: [],
        });
      }
    });
    return edges;
  }

  addElements() {
    super.addElements();

    const meta = this._cachedMeta;
    const edges = this._parseEdges();
    const metaData = (meta.edges = new Array(edges.length));

    for (let i = 0; i < edges.length; ++i) {
      metaData[i] = new this.edgeElementType();
    }
  }

  _resyncEdgeElements() {
    const meta = this._cachedMeta;
    const edges = this._parseEdges();
    const metaData = meta.edges || (meta.edges = []);

    for (let i = 0; i < edges.length; ++i) {
      metaData[i] = metaData[i] || new this.edgeElementType();
    }
    if (edges.length < metaData.length) {
      metaData.splice(edges.length, metaData.length);
    }
  }

  _insertElements(start: number, count: number) {
    super._insertElements(start, count);
    if (count > 0) {
      this._resyncEdgeElements();
    }
  }

  _removeElements(start: number, count: number) {
    super._removeElements(start, count);
    if (count > 0) {
      this._resyncEdgeElements();
    }
  }

  _insertEdgeElements(start: number, count: number) {
    const elements = [];
    for (let i = 0; i < count; i++) {
      elements.push(new this.edgeElementType());
    }
    this._cachedMeta.edges.splice(start, 0, ...elements);
    this.updateEdgeElements(elements, start, 'reset');
    this._scheduleResyncLayout();
  }

  _onDataPush() {
    (super as any)._onDataPush.apply(this, Array.from(arguments));
    this._scheduleResyncLayout();
  }
  _onDataPop() {
    super._onDataPop();
    this._scheduleResyncLayout();
  }
  _onDataShift() {
    super._onDataShift();
    this._scheduleResyncLayout();
  }
  _onDataSplice() {
    super._onDataSplice.apply(this, Array.from(arguments));
    this._scheduleResyncLayout();
  }
  _onDataUnshift() {
    super._onDataUnshift.apply(this, Array.from(arguments));
    this._scheduleResyncLayout();
  }

  reLayout() {
    // hook
  }

  resetLayout() {
    // hook
  }

  stopLayout() {
    // hook
  }

  _scheduleResyncLayout() {
    if (this._scheduleResyncLayoutId !== -1) {
      return;
    }
    this._scheduleResyncLayoutId = requestAnimationFrame(() => {
      this._scheduleResyncLayoutId = -1;
      this.resyncLayout();
    });
  }

  resyncLayout() {
    // hook
  }

  static readonly id = 'graph';
  static readonly defaults: any = /*#__PURE__*/ merge({}, [
    ScatterController.defaults,
    {
      datasets: {
        clip: 10, // some space in combination with padding
        animation: {
          points: {
            fn: interpolatePoints,
            properties: ['points'],
          },
        },
      },
      layout: {
        padding: 10,
      },
      scales: {
        x: {
          display: false,
          ticks: {
            maxTicksLimit: 2,
            precision: 100,
            minRotation: 0,
            maxRotation: 0,
          },
        },
        y: {
          display: false,
          ticks: {
            maxTicksLimit: 2,
            precision: 100,
            minRotation: 0,
            maxRotation: 0,
          },
        },
      },
      tooltips: {
        callbacks: {
          label(item: ITooltipItem) {
            return item.chart.data.labels[item.dataIndex];
          },
        },
      },
      edgeElementType: EdgeLine.id,
      edgeElementOptions: Object.assign(
        {
          tension: 'lineTension',
          stepped: 'lineStepped',
          directed: 'directed',
          arrowHeadSize: 'arrowHeadSize',
          arrowHeadOffset: 'pointRadius',
        },
        (() => {
          const options: any = {};
          LineController.defaults.datasetElementOptions.forEach((attr: any) => {
            options[attr] = `line${attr[0].toUpperCase()}${attr.slice(1)}`;
          });
          return options;
        })()
      ),
    },
  ]);
}

export class GraphChart extends Chart {
  static readonly id = GraphController.id;

  constructor(item, config) {
    super(item, patchController(config, GraphController, [EdgeLine, Point], LinearScale));
  }
}
