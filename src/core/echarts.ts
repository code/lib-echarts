/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/
import * as zrender from 'zrender/src/zrender';
import {
    assert,
    each,
    isFunction,
    isObject,
    indexOf,
    bind,
    clone,
    setAsPrimitive,
    extend,
    HashMap,
    createHashMap,
    map,
    defaults,
    isDom,
    isArray,
    noop,
    isString,
    retrieve2
} from 'zrender/src/core/util';
import env from 'zrender/src/core/env';
import timsort from 'zrender/src/core/timsort';
import Eventful, { EventCallbackSingleParam } from 'zrender/src/core/Eventful';
import Element, { ElementEvent } from 'zrender/src/Element';
import GlobalModel, {QueryConditionKindA, GlobalModelSetOptionOpts} from '../model/Global';
import ExtensionAPI from './ExtensionAPI';
import CoordinateSystemManager from './CoordinateSystem';
import OptionManager from '../model/OptionManager';
import backwardCompat from '../preprocessor/backwardCompat';
import dataStack from '../processor/dataStack';
import ComponentModel from '../model/Component';
import SeriesModel from '../model/Series';
import ComponentView, {ComponentViewConstructor} from '../view/Component';
import ChartView, {ChartViewConstructor} from '../view/Chart';
import type {CustomSeriesRenderItem} from '../chart/custom/CustomSeries';
import * as graphic from '../util/graphic';
import {getECData} from '../util/innerStore';
import {
    isHighDownDispatcher,
    HOVER_STATE_EMPHASIS,
    HOVER_STATE_BLUR,
    blurSeriesFromHighlightPayload,
    toggleSelectionFromPayload,
    updateSeriesElementSelection,
    getAllSelectedIndices,
    isSelectChangePayload,
    isHighDownPayload,
    HIGHLIGHT_ACTION_TYPE,
    DOWNPLAY_ACTION_TYPE,
    SELECT_ACTION_TYPE,
    UNSELECT_ACTION_TYPE,
    TOGGLE_SELECT_ACTION_TYPE,
    savePathStates,
    enterEmphasis,
    leaveEmphasis,
    leaveBlur,
    enterSelect,
    leaveSelect,
    enterBlur,
    allLeaveBlur,
    findComponentHighDownDispatchers,
    blurComponent,
    handleGlobalMouseOverForHighDown,
    handleGlobalMouseOutForHighDown,
    SELECT_CHANGED_EVENT_TYPE
} from '../util/states';
import * as modelUtil from '../util/model';
import {throttle} from '../util/throttle';
import {seriesStyleTask, dataStyleTask, dataColorPaletteTask} from '../visual/style';
import loadingDefault from '../loading/default';
import Scheduler from './Scheduler';
import darkTheme from '../theme/dark';
import {CoordinateSystemMaster, CoordinateSystemCreator, CoordinateSystemHostModel} from '../coord/CoordinateSystem';
import { parseClassType } from '../util/clazz';
import {ECEventProcessor} from '../util/ECEventProcessor';
import {
    Payload, ECElement, RendererType, ECActionEvent,
    ActionHandler, ActionInfo, OptionPreprocessor, PostUpdater,
    LoadingEffect, LoadingEffectCreator, StageHandlerInternal,
    StageHandlerOverallReset, StageHandler,
    ViewRootGroup, DimensionDefinitionLoose, ECEventData, ThemeOption,
    ECBasicOption,
    ECUnitOption,
    ZRColor,
    ComponentMainType,
    ComponentSubType,
    ColorString,
    SelectChangedEvent,
    ScaleDataValue,
    ZRElementEventName,
    ECElementEvent,
    AnimationOption,
    CoordinateSystemDataLayout,
    NullUndefined,
    CoordinateSystemDataCoord,
} from '../util/types';
import Displayable from 'zrender/src/graphic/Displayable';
import { seriesSymbolTask, dataSymbolTask } from '../visual/symbol';
import { getVisualFromData, getItemVisualFromData } from '../visual/helper';
import { deprecateLog, deprecateReplaceLog, error, warn } from '../util/log';
import { handleLegacySelectEvents } from '../legacy/dataSelectAction';

import { registerExternalTransform } from '../data/helper/transform';
import { createLocaleObject, SYSTEM_LANG, LocaleOption } from './locale';

import type {EChartsOption} from '../export/option';
import { findEventDispatcher } from '../util/event';
import decal from '../visual/decal';
import CanvasPainter from 'zrender/src/canvas/Painter';
import SVGPainter from 'zrender/src/svg/Painter';
import lifecycle, {
    LifecycleEvents,
    UpdateLifecycleTransitionItem,
    UpdateLifecycleParams,
    UpdateLifecycleTransitionOpt
} from './lifecycle';
import { platformApi, setPlatformAPI } from 'zrender/src/core/platform';
import { getImpl } from './impl';
import type geoSourceManager from '../coord/geo/geoSourceManager';
import {
    registerCustomSeries as registerCustom
} from '../chart/custom/customSeriesRegister';

declare let global: any;

type ModelFinder = modelUtil.ModelFinder;

export const version = '6.0.0';

export const dependencies = {
    zrender: '6.0.0'
};

const TEST_FRAME_REMAIN_TIME = 1;

const PRIORITY_PROCESSOR_SERIES_FILTER = 800;
// Some data processors depends on the stack result dimension (to calculate data extent).
// So data stack stage should be in front of data processing stage.
const PRIORITY_PROCESSOR_DATASTACK = 900;
// "Data filter" will block the stream, so it should be
// put at the beginning of data processing.
const PRIORITY_PROCESSOR_FILTER = 1000;
const PRIORITY_PROCESSOR_DEFAULT = 2000;
const PRIORITY_PROCESSOR_STATISTIC = 5000;

const PRIORITY_VISUAL_LAYOUT = 1000;
const PRIORITY_VISUAL_PROGRESSIVE_LAYOUT = 1100;
const PRIORITY_VISUAL_GLOBAL = 2000;
const PRIORITY_VISUAL_CHART = 3000;
const PRIORITY_VISUAL_COMPONENT = 4000;
// Visual property in data. Greater than `PRIORITY_VISUAL_COMPONENT` to enable to
// overwrite the viusal result of component (like `visualMap`)
// using data item specific setting (like itemStyle.xxx on data item)
const PRIORITY_VISUAL_CHART_DATA_CUSTOM = 4500;
// Greater than `PRIORITY_VISUAL_CHART_DATA_CUSTOM` to enable to layout based on
// visual result like `symbolSize`.
const PRIORITY_VISUAL_POST_CHART_LAYOUT = 4600;
const PRIORITY_VISUAL_BRUSH = 5000;
const PRIORITY_VISUAL_ARIA = 6000;
const PRIORITY_VISUAL_DECAL = 7000;

export const PRIORITY = {
    PROCESSOR: {
        FILTER: PRIORITY_PROCESSOR_FILTER,
        SERIES_FILTER: PRIORITY_PROCESSOR_SERIES_FILTER,
        STATISTIC: PRIORITY_PROCESSOR_STATISTIC
    },
    VISUAL: {
        LAYOUT: PRIORITY_VISUAL_LAYOUT,
        PROGRESSIVE_LAYOUT: PRIORITY_VISUAL_PROGRESSIVE_LAYOUT,
        GLOBAL: PRIORITY_VISUAL_GLOBAL,
        CHART: PRIORITY_VISUAL_CHART,
        POST_CHART_LAYOUT: PRIORITY_VISUAL_POST_CHART_LAYOUT,
        COMPONENT: PRIORITY_VISUAL_COMPONENT,
        BRUSH: PRIORITY_VISUAL_BRUSH,
        CHART_ITEM: PRIORITY_VISUAL_CHART_DATA_CUSTOM,
        ARIA: PRIORITY_VISUAL_ARIA,
        DECAL: PRIORITY_VISUAL_DECAL
    }
};

// Main process have three entries: `setOption`, `dispatchAction` and `resize`,
// where they must not be invoked nestedly, except the only case: invoke
// dispatchAction with updateMethod "none" in main process.
// This flag is used to carry out this rule.
// All events will be triggered out side main process (i.e. when !this[IN_MAIN_PROCESS]).
const IN_MAIN_PROCESS_KEY = '__flagInMainProcess' as const;
// Useful for detecting outdated rendering results in scenarios that these issues are involved:
//  - Use shortcut (such as, updateTransform, or no update) to start a main process.
//  - Asynchronously update rendered view (e.g., graph force layout).
//  - Multiple ChartView/ComponentView render to one group cooperatively.
const MAIN_PROCESS_VERSION_KEY = '__mainProcessVersion' as const;
const PENDING_UPDATE = '__pendingUpdate' as const;
const STATUS_NEEDS_UPDATE_KEY = '__needsUpdateStatus' as const;
const ACTION_REG = /^[a-zA-Z0-9_]+$/;

const CONNECT_STATUS_KEY = '__connectUpdateStatus' as const;
const CONNECT_STATUS_PENDING = 0 as const;
const CONNECT_STATUS_UPDATING = 1 as const;
const CONNECT_STATUS_UPDATED = 2 as const;
type ConnectStatus =
    typeof CONNECT_STATUS_PENDING
    | typeof CONNECT_STATUS_UPDATING
    | typeof CONNECT_STATUS_UPDATED;

export type SetOptionTransitionOpt = UpdateLifecycleTransitionOpt;
export type SetOptionTransitionOptItem = UpdateLifecycleTransitionItem;

export interface SetOptionOpts {
    notMerge?: boolean;
    lazyUpdate?: boolean;
    silent?: boolean;
    // Rule: only `id` mapped will be merged,
    // other components of the certain `mainType` will be removed.
    replaceMerge?: GlobalModelSetOptionOpts['replaceMerge'];
    transition?: SetOptionTransitionOpt
};

export interface ResizeOpts {
    width?: number | 'auto', // Can be 'auto' (the same as null/undefined)
    height?: number | 'auto', // Can be 'auto' (the same as null/undefined)
    animation?: AnimationOption
    silent?: boolean // by default false.
};

export interface SetThemeOpts {
    silent?: boolean;
}

interface PostIniter {
    (chart: EChartsType): void
}

type EventMethodName = 'on' | 'off';
function createRegisterEventWithLowercaseECharts(method: EventMethodName) {
    return function (this: ECharts, ...args: any): ECharts {
        if (this.isDisposed()) {
            disposedWarning(this.id);
            return;
        }
        return toLowercaseNameAndCallEventful<ECharts>(this, method, args);
    };
}
function createRegisterEventWithLowercaseMessageCenter(method: EventMethodName) {
    return function (this: MessageCenter, ...args: any): MessageCenter {
        return toLowercaseNameAndCallEventful<MessageCenter>(this, method, args);
    };
}
function toLowercaseNameAndCallEventful<T>(host: T, method: EventMethodName, args: any): T {
    // `args[0]` is event name. Event name is all lowercase.
    args[0] = args[0] && args[0].toLowerCase();
    return Eventful.prototype[method].apply(host, args) as any;
}


class MessageCenter extends Eventful {}
const messageCenterProto = MessageCenter.prototype;
messageCenterProto.on = createRegisterEventWithLowercaseMessageCenter('on');
messageCenterProto.off = createRegisterEventWithLowercaseMessageCenter('off');

// ---------------------------------------
// Internal method names for class ECharts
// ---------------------------------------
let prepare: (ecIns: ECharts) => void;
let prepareView: (ecIns: ECharts, isComponent: boolean) => void;
let updateDirectly: (
    ecIns: ECharts, method: string, payload: Payload, mainType: ComponentMainType, subType?: ComponentSubType
) => void;
type UpdateMethod = (this: ECharts, payload?: Payload, renderParams?: UpdateLifecycleParams) => void;
let updateMethods: {
    prepareAndUpdate: UpdateMethod,
    update: UpdateMethod,
    updateTransform: UpdateMethod,
    updateView: UpdateMethod,
    updateVisual: UpdateMethod,
    updateLayout: UpdateMethod
};
let doConvertPixel: {
    (
        ecIns: ECharts,
        methodName: 'convertFromPixel',
        finder: ModelFinder,
        value: number | number[],
        opt: unknown
    ): number | number[];
    (
        ecIns: ECharts,
        methodName: 'convertToPixel',
        finder: ModelFinder,
        value: CoordinateSystemDataCoord,
        opt: unknown
    ): number | number[];
    (
        ecIns: ECharts,
        methodName: 'convertToLayout',
        finder: ModelFinder,
        value: CoordinateSystemDataCoord,
        opt: unknown
    ): CoordinateSystemDataLayout;
};
let updateStreamModes: (ecIns: ECharts, ecModel: GlobalModel) => void;
let doDispatchAction: (this: ECharts, payload: Payload, silent: boolean) => void;
let flushPendingActions: (this: ECharts, silent: boolean) => void;
let triggerUpdatedEvent: (this: ECharts, silent: boolean) => void;
let bindRenderedEvent: (zr: zrender.ZRenderType, ecIns: ECharts) => void;
let bindMouseEvent: (zr: zrender.ZRenderType, ecIns: ECharts) => void;
let render: (
    ecIns: ECharts, ecModel: GlobalModel, api: ExtensionAPI, payload: Payload, updateParams: UpdateLifecycleParams
) => void;
let renderComponents: (
    ecIns: ECharts, ecModel: GlobalModel, api: ExtensionAPI, payload: Payload,
    updateParams: UpdateLifecycleParams, dirtyList?: ComponentView[]
) => void;
let renderSeries: (
    ecIns: ECharts, ecModel: GlobalModel, api: ExtensionAPI, payload: Payload | 'remain',
    updateParams: UpdateLifecycleParams,
    dirtyMap?: {[uid: string]: any}
) => void;
let createExtensionAPI: (ecIns: ECharts) => ExtensionAPI;
let enableConnect: (ecIns: ECharts) => void;

let markStatusToUpdate: (ecIns: ECharts) => void;
let applyChangedStates: (ecIns: ECharts) => void;
let updateMainProcessVersion: (ecIns: ECharts) => void;

type RenderedEventParam = { elapsedTime: number };
type ECEventDefinition = {
    [key in ZRElementEventName]: EventCallbackSingleParam<ECElementEvent>
} & {
    rendered: EventCallbackSingleParam<RenderedEventParam>
    finished: () => void | boolean
} & {
    // TODO: Use ECActionEvent
    [key: string]: (...args: unknown[]) => void | boolean
};
export type EChartsInitOpts = {
    locale?: string | LocaleOption,
    renderer?: RendererType,
    devicePixelRatio?: number,
    useDirtyRect?: boolean,
    useCoarsePointer?: boolean,
    pointerSize?: number,
    ssr?: boolean,
    width?: number | string,
    height?: number | string
};
class ECharts extends Eventful<ECEventDefinition> {

    /**
     * @readonly
     */
    id: string;

    /**
     * Group id
     * @readonly
     */
    group: string;

    private _ssr: boolean;

    private _zr: zrender.ZRenderType;

    private _dom: HTMLElement;

    private _model: GlobalModel;

    private _throttledZrFlush: zrender.ZRenderType extends {flush: infer R} ? R : never;

    private _theme: ThemeOption;

    private _locale: LocaleOption;

    private _chartsViews: ChartView[] = [];

    private _chartsMap: {[viewId: string]: ChartView} = {};

    private _componentsViews: ComponentView[] = [];

    private _componentsMap: {[viewId: string]: ComponentView} = {};

    private _coordSysMgr: CoordinateSystemManager;

    private _api: ExtensionAPI;

    private _scheduler: Scheduler;

    private _messageCenter: MessageCenter;

    // Can't dispatch action during rendering procedure
    private _pendingActions: Payload[] = [];

    // We use never here so ECEventProcessor will not been exposed.
    // which may include many unexpected types won't be exposed in the types to developers.
    protected _$eventProcessor: never;

    private _disposed: boolean;

    private _loadingFX: LoadingEffect;


    private [PENDING_UPDATE]: {
        silent: boolean
        updateParams: UpdateLifecycleParams
    };
    private [IN_MAIN_PROCESS_KEY]: boolean;
    private [MAIN_PROCESS_VERSION_KEY]: number;
    private [CONNECT_STATUS_KEY]: ConnectStatus;
    private [STATUS_NEEDS_UPDATE_KEY]: boolean;

    constructor(
        dom: HTMLElement,
        // Theme name or themeOption.
        theme?: string | ThemeOption,
        opts?: EChartsInitOpts
    ) {
        super(new ECEventProcessor());

        opts = opts || {};

        this._dom = dom;

        let defaultRenderer = 'canvas';
        let defaultCoarsePointer: 'auto' | boolean = 'auto';
        let defaultUseDirtyRect = false;

        this[MAIN_PROCESS_VERSION_KEY] = 1;

        if (__DEV__) {
            const root = (
                /* eslint-disable-next-line */
                env.hasGlobalWindow ? window : global
            ) as any;

            if (root) {
                defaultRenderer = retrieve2(root.__ECHARTS__DEFAULT__RENDERER__, defaultRenderer);
                defaultCoarsePointer = retrieve2(root.__ECHARTS__DEFAULT__COARSE_POINTER, defaultCoarsePointer);
                defaultUseDirtyRect = retrieve2(root.__ECHARTS__DEFAULT__USE_DIRTY_RECT__, defaultUseDirtyRect);
            }

        }

        if (opts.ssr) {
            zrender.registerSSRDataGetter(el => {
                const ecData = getECData(el);
                const dataIndex = ecData.dataIndex;
                if (dataIndex == null) {
                    return;
                }
                const hashMap = createHashMap();
                hashMap.set('series_index', ecData.seriesIndex);
                hashMap.set('data_index', dataIndex);
                ecData.ssrType && hashMap.set('ssr_type', ecData.ssrType);
                return hashMap;
            });
        }

        const zr = this._zr = zrender.init(dom, {
            renderer: opts.renderer || defaultRenderer,
            devicePixelRatio: opts.devicePixelRatio,
            width: opts.width,
            height: opts.height,
            ssr: opts.ssr,
            useDirtyRect: retrieve2(opts.useDirtyRect, defaultUseDirtyRect),
            useCoarsePointer: retrieve2(opts.useCoarsePointer, defaultCoarsePointer),
            pointerSize: opts.pointerSize
        });
        this._ssr = opts.ssr;

        // Expect 60 fps.
        this._throttledZrFlush = throttle(bind(zr.flush, zr), 17);

        this._updateTheme(theme);

        this._locale = createLocaleObject(opts.locale || SYSTEM_LANG);

        this._coordSysMgr = new CoordinateSystemManager();

        const api = this._api = createExtensionAPI(this);

        // Sort on demand
        function prioritySortFunc(a: StageHandlerInternal, b: StageHandlerInternal): number {
            return a.__prio - b.__prio;
        }
        timsort(visualFuncs, prioritySortFunc);
        timsort(dataProcessorFuncs, prioritySortFunc);

        this._scheduler = new Scheduler(this, api, dataProcessorFuncs, visualFuncs);

        this._messageCenter = new MessageCenter();

        // Init mouse events
        this._initEvents();

        // In case some people write `window.onresize = chart.resize`
        this.resize = bind(this.resize, this);

        zr.animation.on('frame', this._onframe, this);

        bindRenderedEvent(zr, this);

        bindMouseEvent(zr, this);

        // ECharts instance can be used as value.
        setAsPrimitive(this);
    }

    private _onframe(): void {
        if (this._disposed) {
            return;
        }

        applyChangedStates(this);

        const scheduler = this._scheduler;

        // Lazy update
        if (this[PENDING_UPDATE]) {
            const silent = (this[PENDING_UPDATE] as any).silent;

            this[IN_MAIN_PROCESS_KEY] = true;
            updateMainProcessVersion(this);

            try {
                prepare(this);
                updateMethods.update.call(this, null, this[PENDING_UPDATE].updateParams);
            }
            catch (e) {
                this[IN_MAIN_PROCESS_KEY] = false;
                this[PENDING_UPDATE] = null;
                throw e;
            }

            // At present, in each frame, zrender performs:
            //   (1) animation step forward.
            //   (2) trigger('frame') (where this `_onframe` is called)
            //   (3) zrender flush (render).
            // If we do nothing here, since we use `setToFinal: true`, the step (3) above
            // will render the final state of the elements before the real animation started.
            this._zr.flush();

            this[IN_MAIN_PROCESS_KEY] = false;
            this[PENDING_UPDATE] = null;

            flushPendingActions.call(this, silent);
            triggerUpdatedEvent.call(this, silent);
        }
        // Avoid do both lazy update and progress in one frame.
        else if (scheduler.unfinished) {
            // Stream progress.
            let remainTime = TEST_FRAME_REMAIN_TIME;
            const ecModel = this._model;
            const api = this._api;
            scheduler.unfinished = false;
            do {
                const startTime = +new Date();

                scheduler.performSeriesTasks(ecModel);

                // Currently dataProcessorFuncs do not check threshold.
                scheduler.performDataProcessorTasks(ecModel);

                updateStreamModes(this, ecModel);

                // Do not update coordinate system here. Because that coord system update in
                // each frame is not a good user experience. So we follow the rule that
                // the extent of the coordinate system is determined in the first frame (the
                // frame is executed immediately after task reset.
                // this._coordSysMgr.update(ecModel, api);

                // console.log('--- ec frame visual ---', remainTime);
                scheduler.performVisualTasks(ecModel);

                renderSeries(this, this._model, api, 'remain', {});

                remainTime -= (+new Date() - startTime);
            }
            while (remainTime > 0 && scheduler.unfinished);

            // Call flush explicitly for trigger finished event.
            if (!scheduler.unfinished) {
                this._zr.flush();
            }
            // Else, zr flushing be ensue within the same frame,
            // because zr flushing is after onframe event.
        }
    }

    getDom(): HTMLElement {
        return this._dom;
    }

    getId(): string {
        return this.id;
    }

    getZr(): zrender.ZRenderType {
        return this._zr;
    }

    isSSR(): boolean {
        return this._ssr;
    }

    /**
     * Usage:
     * chart.setOption(option, notMerge, lazyUpdate);
     * chart.setOption(option, {
     *     notMerge: ...,
     *     lazyUpdate: ...,
     *     silent: ...
     * });
     *
     * @param opts opts or notMerge.
     * @param opts.notMerge Default `false`.
     * @param opts.lazyUpdate Default `false`. Useful when setOption frequently.
     * @param opts.silent Default `false`.
     * @param opts.replaceMerge Default undefined.
     */
    // Expose to user full option.
    setOption<Opt extends ECBasicOption>(option: Opt, notMerge?: boolean, lazyUpdate?: boolean): void;
    setOption<Opt extends ECBasicOption>(option: Opt, opts?: SetOptionOpts): void;
    /* eslint-disable-next-line */
    setOption<Opt extends ECBasicOption>(option: Opt, notMerge?: boolean | SetOptionOpts, lazyUpdate?: boolean): void {
        if (this[IN_MAIN_PROCESS_KEY]) {
            if (__DEV__) {
                error('`setOption` should not be called during main process.');
            }
            return;
        }

        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        let silent;
        let replaceMerge;
        let transitionOpt: SetOptionTransitionOpt;
        if (isObject(notMerge)) {
            lazyUpdate = notMerge.lazyUpdate;
            silent = notMerge.silent;
            replaceMerge = notMerge.replaceMerge;
            transitionOpt = notMerge.transition;
            notMerge = notMerge.notMerge;
        }

        this[IN_MAIN_PROCESS_KEY] = true;
        updateMainProcessVersion(this);

        if (!this._model || notMerge) {
            const optionManager = new OptionManager(this._api);
            const theme = this._theme;
            const ecModel = this._model = new GlobalModel();
            ecModel.scheduler = this._scheduler;
            ecModel.ssr = this._ssr;
            ecModel.init(null, null, null, theme, this._locale, optionManager);
        }

        this._model.setOption(option as ECBasicOption, { replaceMerge }, optionPreprocessorFuncs);

        const updateParams = {
            seriesTransition: transitionOpt,
            optionChanged: true
        } as UpdateLifecycleParams;

        if (lazyUpdate) {
            this[PENDING_UPDATE] = {
                silent: silent,
                updateParams: updateParams
            };
            this[IN_MAIN_PROCESS_KEY] = false;

            // `setOption(option, {lazyMode: true})` may be called when zrender has been slept.
            // It should wake it up to make sure zrender start to render at the next frame.
            this.getZr().wakeUp();
        }
        else {
            try {
                prepare(this);
                updateMethods.update.call(this, null, updateParams);
            }
            catch (e) {
                this[PENDING_UPDATE] = null;
                this[IN_MAIN_PROCESS_KEY] = false;

                throw e;
            }

            // Ensure zr refresh sychronously, and then pixel in canvas can be
            // fetched after `setOption`.
            if (!this._ssr) {
                // not use flush when using ssr mode.
                this._zr.flush();
            }

            this[PENDING_UPDATE] = null;
            this[IN_MAIN_PROCESS_KEY] = false;

            flushPendingActions.call(this, silent);
            triggerUpdatedEvent.call(this, silent);
        }
    }

    /**
     * Update theme with name or theme option and repaint the chart.
     * @param theme Theme name or theme option.
     * @param opts Optional settings
     */
    setTheme(theme: string | ThemeOption, opts?: SetThemeOpts): void {
        if (this[IN_MAIN_PROCESS_KEY]) {
            if (__DEV__) {
                error('`setTheme` should not be called during main process.');
            }
            return;
        }

        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        const ecModel = this._model;
        if (!ecModel) {
            return;
        }

        let silent = opts && opts.silent;
        let updateParams = null as UpdateLifecycleParams;

        if (this[PENDING_UPDATE]) {
            if (silent == null) {
                silent = (this[PENDING_UPDATE] as any).silent;
            }
            updateParams = (this[PENDING_UPDATE] as any).updateParams;
            this[PENDING_UPDATE] = null;
        }

        this[IN_MAIN_PROCESS_KEY] = true;
        updateMainProcessVersion(this);

        try {
            this._updateTheme(theme);
            ecModel.setTheme(this._theme);

            prepare(this);
            updateMethods.update.call(this, {type: 'setTheme'}, updateParams);
        }
        catch (e) {
            this[IN_MAIN_PROCESS_KEY] = false;
            throw e;
        }

        this[IN_MAIN_PROCESS_KEY] = false;

        flushPendingActions.call(this, silent);
        triggerUpdatedEvent.call(this, silent);
    }

    private _updateTheme(theme: string | ThemeOption): void {
        if (isString(theme)) {
            theme = themeStorage[theme] as object;
        }

        if (theme) {
            theme = clone(theme);
            theme && backwardCompat(theme as ECUnitOption, true);
            this._theme = theme;
        }
    }

    // We don't want developers to use getModel directly.
    private getModel(): GlobalModel {
        return this._model;
    }

    getOption(): ECBasicOption {
        return this._model && this._model.getOption() as ECBasicOption;
    }

    getWidth(): number {
        return this._zr.getWidth();
    }

    getHeight(): number {
        return this._zr.getHeight();
    }

    getDevicePixelRatio(): number {
        return (this._zr.painter as CanvasPainter).dpr
            /* eslint-disable-next-line */
            || (env.hasGlobalWindow && window.devicePixelRatio) || 1;
    }

    /**
     * Get canvas which has all thing rendered
     * @deprecated Use renderToCanvas instead.
     */
    getRenderedCanvas(opts?: any): HTMLCanvasElement {
        if (__DEV__) {
            deprecateReplaceLog('getRenderedCanvas', 'renderToCanvas');
        }
        return this.renderToCanvas(opts);
    }

    renderToCanvas(opts?: {
        backgroundColor?: ZRColor
        pixelRatio?: number
    }): HTMLCanvasElement {
        opts = opts || {};
        const painter = this._zr.painter;
        if (__DEV__) {
            if (painter.type !== 'canvas') {
                throw new Error('renderToCanvas can only be used in the canvas renderer.');
            }
        }
        return (painter as CanvasPainter).getRenderedCanvas({
            backgroundColor: (opts.backgroundColor || this._model.get('backgroundColor')) as ColorString,
            pixelRatio: opts.pixelRatio || this.getDevicePixelRatio()
        });
    }

    renderToSVGString(opts?: {
        useViewBox?: boolean
    }): string {
        opts = opts || {};
        const painter = this._zr.painter;
        if (__DEV__) {
            if (painter.type !== 'svg') {
                throw new Error('renderToSVGString can only be used in the svg renderer.');
            }
        }
        return (painter as SVGPainter).renderToString({
            useViewBox: opts.useViewBox
        });
    }

    /**
     * Get svg data url
     */
    getSvgDataURL(): string {
        const zr = this._zr;
        const list = zr.storage.getDisplayList();
        // Stop animations
        each(list, function (el: Element) {
            el.stopAnimation(null, true);
        });

        return (zr.painter as SVGPainter).toDataURL();
    }

    getDataURL(opts?: {
        // file type 'png' by default
        type?: 'png' | 'jpeg' | 'svg',
        pixelRatio?: number,
        backgroundColor?: ZRColor,
        // component type array
        excludeComponents?: ComponentMainType[]
    }): string {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        opts = opts || {};
        const excludeComponents = opts.excludeComponents;
        const ecModel = this._model;
        const excludesComponentViews: ComponentView[] = [];
        const self = this;

        each(excludeComponents, function (componentType) {
            ecModel.eachComponent({
                mainType: componentType
            }, function (component) {
                const view = self._componentsMap[component.__viewId];
                if (!view.group.ignore) {
                    excludesComponentViews.push(view);
                    view.group.ignore = true;
                }
            });
        });

        const url = this._zr.painter.getType() === 'svg'
            ? this.getSvgDataURL()
            : this.renderToCanvas(opts).toDataURL(
                'image/' + (opts && opts.type || 'png')
            );

        each(excludesComponentViews, function (view) {
            view.group.ignore = false;
        });

        return url;
    }

    getConnectedDataURL(opts?: {
        // file type 'png' by default
        type?: 'png' | 'jpeg' | 'svg',
        pixelRatio?: number,
        backgroundColor?: ZRColor,
        connectedBackgroundColor?: ZRColor
        excludeComponents?: string[]
    }): string {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        const isSvg = opts.type === 'svg';
        const groupId = this.group;
        const mathMin = Math.min;
        const mathMax = Math.max;
        const MAX_NUMBER = Infinity;
        if (connectedGroups[groupId]) {
            let left = MAX_NUMBER;
            let top = MAX_NUMBER;
            let right = -MAX_NUMBER;
            let bottom = -MAX_NUMBER;
            const canvasList: {dom: HTMLCanvasElement | string, left: number, top: number}[] = [];
            const dpr = (opts && opts.pixelRatio) || this.getDevicePixelRatio();

            each(instances, function (chart, id) {
                if (chart.group === groupId) {
                    const canvas = isSvg
                        ? (chart.getZr().painter as SVGPainter).getSvgDom().innerHTML
                        : chart.renderToCanvas(clone(opts));
                    const boundingRect = chart.getDom().getBoundingClientRect();
                    left = mathMin(boundingRect.left, left);
                    top = mathMin(boundingRect.top, top);
                    right = mathMax(boundingRect.right, right);
                    bottom = mathMax(boundingRect.bottom, bottom);
                    canvasList.push({
                        dom: canvas,
                        left: boundingRect.left,
                        top: boundingRect.top
                    });
                }
            });

            left *= dpr;
            top *= dpr;
            right *= dpr;
            bottom *= dpr;
            const width = right - left;
            const height = bottom - top;
            const targetCanvas = platformApi.createCanvas();
            const zr = zrender.init(targetCanvas, {
                renderer: isSvg ? 'svg' : 'canvas'
            });
            zr.resize({
                width: width,
                height: height
            });

            if (isSvg) {
                let content = '';
                each(canvasList, function (item) {
                    const x = item.left - left;
                    const y = item.top - top;
                    content += '<g transform="translate(' + x + ','
                        + y + ')">' + item.dom + '</g>';
                });
                (zr.painter as SVGPainter).getSvgRoot().innerHTML = content;

                if (opts.connectedBackgroundColor) {
                    (zr.painter as SVGPainter).setBackgroundColor(opts.connectedBackgroundColor as string);
                }

                zr.refreshImmediately();
                return (zr.painter as SVGPainter).toDataURL();
            }
            else {
                // Background between the charts
                if (opts.connectedBackgroundColor) {
                    zr.add(new graphic.Rect({
                        shape: {
                            x: 0,
                            y: 0,
                            width: width,
                            height: height
                        },
                        style: {
                            fill: opts.connectedBackgroundColor
                        }
                    }));
                }

                each(canvasList, function (item) {
                    const img = new graphic.Image({
                        style: {
                            x: item.left * dpr - left,
                            y: item.top * dpr - top,
                            image: item.dom
                        }
                    });
                    zr.add(img);
                });
                zr.refreshImmediately();

                return targetCanvas.toDataURL('image/' + (opts && opts.type || 'png'));
            }
        }
        else {
            return this.getDataURL(opts);
        }
    }

    /**
     * Convert from logical coordinate system to pixel coordinate system.
     * See CoordinateSystem#convertToPixel.
     *
     * TODO / PENDING:
     *  currently `convertToPixel` `convertFromPixel` `convertToLayout` may not be suitable
     *  for some extremely performance-sensitive scenarios (such as, handling massive amounts of data),
     *  since it performce "find component" every time.
     *  And it is not friendly to the nuances between different coordinate systems.
     *  @see https://github.com/apache/echarts/issues/20985 for details
     *
     * @see CoordinateSystem['dataToPoint'] for parameters and return.
     * @see CoordinateSystemDataCoord
     */
    convertToPixel(finder: ModelFinder, value: ScaleDataValue): number;
    convertToPixel(finder: ModelFinder, value: ScaleDataValue[]): number[];
    convertToPixel(
        finder: ModelFinder, value: ScaleDataValue | ScaleDataValue[]
    ): number | number[];
    // The above are signatures from before v6, thus they should be preserved for backward compat.
    convertToPixel(
        finder: ModelFinder, value: (ScaleDataValue | ScaleDataValue[] | NullUndefined)[]
    ): number | number[];
    convertToPixel(
        finder: ModelFinder,
        value: (ScaleDataValue | NullUndefined) | (ScaleDataValue | ScaleDataValue[] | NullUndefined)[],
        opt?: unknown
    ): number | number[] {
        return doConvertPixel(this, 'convertToPixel', finder, value, opt);
    }

    /**
     * Convert from logical coordinate system to pixel coordinate system.
     * See CoordinateSystem#convertToPixel.
     *
     * @see CoordinateSystem['dataToLayout'] for parameters and return.
     * @see CoordinateSystemDataCoord
     */
    convertToLayout(
        finder: ModelFinder,
        value: (ScaleDataValue | NullUndefined) | (ScaleDataValue | ScaleDataValue[] | NullUndefined)[],
        opt?: unknown
    ): CoordinateSystemDataLayout {
        return doConvertPixel(this, 'convertToLayout', finder, value, opt);
    }

    /**
     * Convert from pixel coordinate system to logical coordinate system.
     * See CoordinateSystem#convertFromPixel.
     *
     * @see CoordinateSystem['pointToData'] for parameters and return.
     */
    convertFromPixel(finder: ModelFinder, value: number): number;
    convertFromPixel(finder: ModelFinder, value: number[]): number[];
    convertFromPixel(finder: ModelFinder, value: number | number[]): number | number[];
    // The above are signatures from before v6, thus they should be preserved for backward compat.
    convertFromPixel(finder: ModelFinder, value: number | number[], opt?: unknown): number | number[] {
        return doConvertPixel(this, 'convertFromPixel', finder, value, opt);
    }

    /**
     * Is the specified coordinate systems or components contain the given pixel point.
     * @param {Array|number} value
     * @return {boolean} result
     */
    containPixel(finder: ModelFinder, value: number[]): boolean {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        const ecModel = this._model;
        let result: boolean;

        const findResult = modelUtil.parseFinder(ecModel, finder);

        each(findResult, function (models, key) {
            key.indexOf('Models') >= 0 && each(models as ComponentModel[], function (model) {
                const coordSys = (model as CoordinateSystemHostModel).coordinateSystem;
                if (coordSys && coordSys.containPoint) {
                    result = result || !!coordSys.containPoint(value);
                }
                else if (key === 'seriesModels') {
                    const view = this._chartsMap[model.__viewId];
                    if (view && view.containPoint) {
                        result = result || view.containPoint(value, model as SeriesModel);
                    }
                    else {
                        if (__DEV__) {
                            warn(key + ': ' + (view
                                ? 'The found component do not support containPoint.'
                                : 'No view mapping to the found component.'
                            ));
                        }
                    }
                }
                else {
                    if (__DEV__) {
                        warn(key + ': containPoint is not supported');
                    }
                }
            }, this);
        }, this);

        return !!result;
    }

    /**
     * Get visual from series or data.
     * @param finder
     *        If string, e.g., 'series', means {seriesIndex: 0}.
     *        If Object, could contain some of these properties below:
     *        {
     *            seriesIndex / seriesId / seriesName,
     *            dataIndex / dataIndexInside
     *        }
     *        If dataIndex is not specified, series visual will be fetched,
     *        but not data item visual.
     *        If all of seriesIndex, seriesId, seriesName are not specified,
     *        visual will be fetched from first series.
     * @param visualType 'color', 'symbol', 'symbolSize'
     */
    getVisual(finder: ModelFinder, visualType: string) {
        const ecModel = this._model;

        const parsedFinder = modelUtil.parseFinder(ecModel, finder, {
            defaultMainType: 'series'
        }) as modelUtil.ParsedModelFinderKnown;

        const seriesModel = parsedFinder.seriesModel;

        if (__DEV__) {
            if (!seriesModel) {
                warn('There is no specified series model');
            }
        }

        const data = seriesModel.getData();

        const dataIndexInside = parsedFinder.hasOwnProperty('dataIndexInside')
            ? parsedFinder.dataIndexInside
            : parsedFinder.hasOwnProperty('dataIndex')
            ? data.indexOfRawIndex(parsedFinder.dataIndex)
            : null;

        return dataIndexInside != null
            ? getItemVisualFromData(data, dataIndexInside, visualType)
            : getVisualFromData(data, visualType);
    }

    /**
     * Get view of corresponding component model
     */
    private getViewOfComponentModel(componentModel: ComponentModel): ComponentView {
        return this._componentsMap[componentModel.__viewId];
    }

    /**
     * Get view of corresponding series model
     */
    private getViewOfSeriesModel(seriesModel: SeriesModel): ChartView {
        return this._chartsMap[seriesModel.__viewId];
    }


    private _initEvents(): void {
        each(MOUSE_EVENT_NAMES, (eveName) => {
            const handler = (e: ElementEvent) => {
                const ecModel = this.getModel();
                const el = e.target;
                let params: ECElementEvent;
                const isGlobalOut = eveName === 'globalout';
                // no e.target when 'globalout'.
                if (isGlobalOut) {
                    params = {} as ECElementEvent;
                }
                else {
                    el && findEventDispatcher(el, (parent) => {
                        const ecData = getECData(parent);
                        if (ecData && ecData.dataIndex != null) {
                            const dataModel = ecData.dataModel || ecModel.getSeriesByIndex(ecData.seriesIndex);
                            params = (
                                dataModel && dataModel.getDataParams(ecData.dataIndex, ecData.dataType, el) || {}
                            ) as ECElementEvent;
                            return true;
                        }
                        // If element has custom eventData of components
                        else if (ecData.eventData) {
                            params = extend({}, ecData.eventData) as ECElementEvent;
                            return true;
                        }
                    }, true);
                }

                // Contract: if params prepared in mouse event,
                // these properties must be specified:
                // {
                //    componentType: string (component main type)
                //    componentIndex: number
                // }
                // Otherwise event query can not work.

                if (params) {
                    let componentType = params.componentType;
                    let componentIndex = params.componentIndex;
                    // Special handling for historic reason: when trigger by
                    // markLine/markPoint/markArea, the componentType is
                    // 'markLine'/'markPoint'/'markArea', but we should better
                    // enable them to be queried by seriesIndex, since their
                    // option is set in each series.
                    if (componentType === 'markLine'
                        || componentType === 'markPoint'
                        || componentType === 'markArea'
                    ) {
                        componentType = 'series';
                        componentIndex = params.seriesIndex;
                    }
                    const model = componentType && componentIndex != null
                        && ecModel.getComponent(componentType, componentIndex);
                    const view = model && this[
                        model.mainType === 'series' ? '_chartsMap' : '_componentsMap'
                    ][model.__viewId];

                    if (__DEV__) {
                        // `event.componentType` and `event[componentTpype + 'Index']` must not
                        // be missed, otherwise there is no way to distinguish source component.
                        // See `dataFormat.getDataParams`.
                        if (!isGlobalOut && !(model && view)) {
                            warn('model or view can not be found by params');
                        }
                    }

                    params.event = e;
                    params.type = eveName;

                    (this._$eventProcessor as ECEventProcessor).eventInfo = {
                        targetEl: el,
                        packedEvent: params,
                        model: model,
                        view: view
                    };

                    this.trigger(eveName, params);
                }
            };
            // Consider that some component (like tooltip, brush, ...)
            // register zr event handler, but user event handler might
            // do anything, such as call `setOption` or `dispatchAction`,
            // which probably update any of the content and probably
            // cause problem if it is called previous other inner handlers.
            (handler as any).zrEventfulCallAtLast = true;
            this._zr.on(eveName, handler, this);
        });

        const messageCenter = this._messageCenter;
        each(publicEventTypeMap, (_, eventType) => {
            messageCenter.on(eventType, event => {
                this.trigger(eventType, event);
            });
        });

        handleLegacySelectEvents(messageCenter, this, this._api);
    }

    isDisposed(): boolean {
        return this._disposed;
    }

    clear(): void {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }
        this.setOption({ series: [] } as EChartsOption, true);
    }

    dispose(): void {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }
        this._disposed = true;

        const dom = this.getDom();
        if (dom) {
            modelUtil.setAttribute(this.getDom(), DOM_ATTRIBUTE_KEY, '');
        }

        const chart = this;
        const api = chart._api;
        const ecModel = chart._model;

        each(chart._componentsViews, function (component) {
            component.dispose(ecModel, api);
        });
        each(chart._chartsViews, function (chart) {
            chart.dispose(ecModel, api);
        });

        // Dispose after all views disposed
        chart._zr.dispose();

        // Set properties to null.
        // To reduce the memory cost in case the top code still holds this instance unexpectedly.
        chart._dom =
        chart._model =
        chart._chartsMap =
        chart._componentsMap =
        chart._chartsViews =
        chart._componentsViews =
        chart._scheduler =
        chart._api =
        chart._zr =
        chart._throttledZrFlush =
        chart._theme =
        chart._coordSysMgr =
        chart._messageCenter = null;

        delete instances[chart.id];
    }

    /**
     * Resize the chart
     */
    resize(opts?: ResizeOpts): void {
        if (this[IN_MAIN_PROCESS_KEY]) {
            if (__DEV__) {
                error('`resize` should not be called during main process.');
            }
            return;
        }

        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        this._zr.resize(opts);

        const ecModel = this._model;

        // Resize loading effect
        this._loadingFX && this._loadingFX.resize();

        if (!ecModel) {
            return;
        }

        let needPrepare = ecModel.resetOption('media');

        let silent = opts && opts.silent;

        // There is some real cases that:
        // chart.setOption(option, { lazyUpdate: true });
        // chart.resize();
        if (this[PENDING_UPDATE]) {
            if (silent == null) {
                silent = (this[PENDING_UPDATE] as any).silent;
            }
            needPrepare = true;
            this[PENDING_UPDATE] = null;
        }

        this[IN_MAIN_PROCESS_KEY] = true;
        updateMainProcessVersion(this);

        try {
            needPrepare && prepare(this);
            updateMethods.update.call(this, {
                type: 'resize',
                animation: extend({
                    // Disable animation
                    duration: 0
                }, opts && opts.animation)
            });
        }
        catch (e) {
            this[IN_MAIN_PROCESS_KEY] = false;
            throw e;
        }

        this[IN_MAIN_PROCESS_KEY] = false;

        flushPendingActions.call(this, silent);

        triggerUpdatedEvent.call(this, silent);
    }

    /**
     * Show loading effect
     * @param name 'default' by default
     * @param cfg cfg of registered loading effect
     */
    showLoading(cfg?: object): void;
    showLoading(name?: string, cfg?: object): void;
    showLoading(name?: string | object, cfg?: object): void {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        if (isObject(name)) {
            cfg = name as object;
            name = '';
        }
        name = name || 'default';

        this.hideLoading();
        if (!loadingEffects[name]) {
            if (__DEV__) {
                warn('Loading effects ' + name + ' not exists.');
            }
            return;
        }
        const el = loadingEffects[name](this._api, cfg);
        const zr = this._zr;
        this._loadingFX = el;

        zr.add(el);
    }

    /**
     * Hide loading effect
     */
    hideLoading(): void {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        this._loadingFX && this._zr.remove(this._loadingFX);
        this._loadingFX = null;
    }

    makeActionFromEvent(eventObj: ECActionEvent): Payload {
        const payload = extend({}, eventObj) as Payload;
        payload.type = connectionEventRevertMap[eventObj.type];
        return payload;
    }

    /**
     * @param opt If pass boolean, means opt.silent
     * @param opt.silent Default `false`. Whether trigger events.
     * @param opt.flush Default `undefined`.
     *        true: Flush immediately, and then pixel in canvas can be fetched
     *            immediately. Caution: it might affect performance.
     *        false: Not flush.
     *        undefined: Auto decide whether perform flush.
     */
    dispatchAction(
        payload: Payload,
        opt?: boolean | {
            silent?: boolean,
            flush?: boolean | undefined
        }
    ): void {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        if (!isObject(opt)) {
            opt = {silent: !!opt};
        }

        if (!actions[payload.type]) {
            return;
        }

        // Avoid dispatch action before setOption. Especially in `connect`.
        if (!this._model) {
            return;
        }

        // May dispatchAction in rendering procedure
        if (this[IN_MAIN_PROCESS_KEY]) {
            this._pendingActions.push(payload);
            return;
        }

        const silent = opt.silent;
        doDispatchAction.call(this, payload, silent);

        const flush = opt.flush;
        if (flush) {
            this._zr.flush();
        }
        else if (flush !== false && env.browser.weChat) {
            // In WeChat embedded browser, `requestAnimationFrame` and `setInterval`
            // hang when sliding page (on touch event), which cause that zr does not
            // refresh until user interaction finished, which is not expected.
            // But `dispatchAction` may be called too frequently when pan on touch
            // screen, which impacts performance if do not throttle them.
            this._throttledZrFlush();
        }

        flushPendingActions.call(this, silent);

        triggerUpdatedEvent.call(this, silent);
    }

    updateLabelLayout() {
        lifecycle.trigger('series:layoutlabels', this._model, this._api, {
            // Not adding series labels.
            // TODO
            updatedSeries: []
        });
    }

    appendData(params: {
        seriesIndex: number,
        data: any
    }): void {
        if (this._disposed) {
            disposedWarning(this.id);
            return;
        }

        const seriesIndex = params.seriesIndex;
        const ecModel = this.getModel();
        const seriesModel = ecModel.getSeriesByIndex(seriesIndex) as SeriesModel;

        if (__DEV__) {
            assert(params.data && seriesModel);
        }

        seriesModel.appendData(params);

        // Note: `appendData` does not support that update extent of coordinate
        // system, util some scenario require that. In the expected usage of
        // `appendData`, the initial extent of coordinate system should better
        // be fixed by axis `min`/`max` setting or initial data, otherwise if
        // the extent changed while `appendData`, the location of the painted
        // graphic elements have to be changed, which make the usage of
        // `appendData` meaningless.

        this._scheduler.unfinished = true;

        this.getZr().wakeUp();
    }


    // A work around for no `internal` modifier in ts yet but
    // need to strictly hide private methods to JS users.
    private static internalField = (function () {

        prepare = function (ecIns: ECharts): void {
            const scheduler = ecIns._scheduler;

            scheduler.restorePipelines(ecIns._model);
            scheduler.prepareStageTasks();

            prepareView(ecIns, true);
            prepareView(ecIns, false);

            scheduler.plan();
        };

        /**
         * Prepare view instances of charts and components
         */
        prepareView = function (ecIns: ECharts, isComponent: boolean): void {
            const ecModel = ecIns._model;
            const scheduler = ecIns._scheduler;
            const viewList = isComponent ? ecIns._componentsViews : ecIns._chartsViews;
            const viewMap = isComponent ? ecIns._componentsMap : ecIns._chartsMap;
            const zr = ecIns._zr;
            const api = ecIns._api;

            for (let i = 0; i < viewList.length; i++) {
                viewList[i].__alive = false;
            }

            isComponent
                ? ecModel.eachComponent(function (componentType, model) {
                    componentType !== 'series' && doPrepare(model);
                })
                : ecModel.eachSeries(doPrepare);

            function doPrepare(model: ComponentModel): void {
                // By default view will be reused if possible for the case that `setOption` with "notMerge"
                // mode and need to enable transition animation. (Usually, when they have the same id, or
                // especially no id but have the same type & name & index. See the `model.id` generation
                // rule in `makeIdAndName` and `viewId` generation rule here).
                // But in `replaceMerge` mode, this feature should be able to disabled when it is clear that
                // the new model has nothing to do with the old model.
                const requireNewView = model.__requireNewView;
                // This command should not work twice.
                model.__requireNewView = false;
                // Consider: id same and type changed.
                const viewId = '_ec_' + model.id + '_' + model.type;
                let view = !requireNewView && viewMap[viewId];
                if (!view) {
                    const classType = parseClassType(model.type);
                    const Clazz = isComponent
                        ? (ComponentView as ComponentViewConstructor).getClass(classType.main, classType.sub)
                        : (
                            // FIXME:TS
                            // (ChartView as ChartViewConstructor).getClass('series', classType.sub)
                            // For backward compat, still support a chart type declared as only subType
                            // like "liquidfill", but recommend "series.liquidfill"
                            // But need a base class to make a type series.
                            (ChartView as ChartViewConstructor).getClass(classType.sub)
                        );

                    if (__DEV__) {
                        assert(Clazz, classType.sub + ' does not exist.');
                    }

                    view = new Clazz();
                    view.init(ecModel, api);
                    viewMap[viewId] = view;
                    viewList.push(view as any);
                    zr.add(view.group);
                }

                model.__viewId = view.__id = viewId;
                view.__alive = true;
                view.__model = model;
                view.group.__ecComponentInfo = {
                    mainType: model.mainType,
                    index: model.componentIndex
                };
                !isComponent && scheduler.prepareView(
                    view as ChartView, model as SeriesModel, ecModel, api
                );
            }

            for (let i = 0; i < viewList.length;) {
                const view = viewList[i];
                if (!view.__alive) {
                    !isComponent && (view as ChartView).renderTask.dispose();
                    zr.remove(view.group);
                    view.dispose(ecModel, api);
                    viewList.splice(i, 1);
                    if (viewMap[view.__id] === view) {
                        delete viewMap[view.__id];
                    }
                    view.__id = view.group.__ecComponentInfo = null;
                }
                else {
                    i++;
                }
            }
        };

        updateDirectly = function (
            ecIns: ECharts,
            method: string,
            payload: Payload,
            mainType: ComponentMainType,
            subType?: ComponentSubType
        ): void {
            const ecModel = ecIns._model;

            ecModel.setUpdatePayload(payload);

            // broadcast
            if (!mainType) {
                // FIXME
                // Chart will not be update directly here, except set dirty.
                // But there is no such scenario now.
                each([].concat(ecIns._componentsViews).concat(ecIns._chartsViews), callView);
                return;
            }

            const query: QueryConditionKindA['query'] = {};
            query[mainType + 'Id'] = payload[mainType + 'Id'] as any;
            query[mainType + 'Index'] = payload[mainType + 'Index'] as any;
            query[mainType + 'Name'] = payload[mainType + 'Name'] as any;

            const condition = {mainType: mainType, query: query} as QueryConditionKindA;
            subType && (condition.subType = subType); // subType may be '' by parseClassType;

            const excludeSeriesId = payload.excludeSeriesId;
            let excludeSeriesIdMap: HashMap<true, string>;
            if (excludeSeriesId != null) {
                excludeSeriesIdMap = createHashMap();
                each(modelUtil.normalizeToArray(excludeSeriesId), id => {
                    const modelId = modelUtil.convertOptionIdName(id, null);
                    if (modelId != null) {
                        excludeSeriesIdMap.set(modelId, true);
                    }
                });
            }

            // If dispatchAction before setOption, do nothing.
            ecModel && ecModel.eachComponent(condition, function (model) {
                const isExcluded = excludeSeriesIdMap && excludeSeriesIdMap.get(model.id) != null;
                if (isExcluded) {
                    return;
                };
                if (isHighDownPayload(payload)) {
                    if (model instanceof SeriesModel) {
                        if (
                            payload.type === HIGHLIGHT_ACTION_TYPE
                            && !payload.notBlur && !model.get(['emphasis', 'disabled'])
                        ) {
                            blurSeriesFromHighlightPayload(model, payload, ecIns._api);
                        }
                    }
                    else {
                        const { focusSelf, dispatchers } = findComponentHighDownDispatchers(
                            model.mainType, model.componentIndex, payload.name as string, ecIns._api
                        );
                        if (payload.type === HIGHLIGHT_ACTION_TYPE && focusSelf && !payload.notBlur) {
                            blurComponent(model.mainType, model.componentIndex, ecIns._api);
                        }
                        // PENDING:
                        // Whether to put this "enter emphasis" code in `ComponentView`,
                        // which will be the same as `ChartView` but might be not necessary
                        // and will be far from this logic.
                        if (dispatchers) {
                            each(dispatchers, dispatcher => {
                                payload.type === HIGHLIGHT_ACTION_TYPE
                                    ? enterEmphasis(dispatcher)
                                    : leaveEmphasis(dispatcher);
                            });
                        }
                    }
                }
                else if (isSelectChangePayload(payload)) {
                    // TODO geo
                    if (model instanceof SeriesModel) {
                        toggleSelectionFromPayload(model, payload, ecIns._api);
                        updateSeriesElementSelection(model);
                        markStatusToUpdate(ecIns);
                    }
                }
            }, ecIns);

            ecModel && ecModel.eachComponent(condition, function (model) {
                const isExcluded = excludeSeriesIdMap && excludeSeriesIdMap.get(model.id) != null;
                if (isExcluded) {
                    return;
                };
                callView(ecIns[
                    mainType === 'series' ? '_chartsMap' : '_componentsMap'
                ][model.__viewId]);
            }, ecIns);

            function callView(view: ComponentView | ChartView) {
                view && view.__alive && (view as any)[method] && (view as any)[method](
                    view.__model, ecModel, ecIns._api, payload
                );
            }
        };

        updateMethods = {

            prepareAndUpdate(this: ECharts, payload: Payload): void {
                prepare(this);
                updateMethods.update.call(this, payload, payload && {
                    // Needs to mark option changed if newOption is given.
                    // It's from MagicType.
                    // TODO If use a separate flag optionChanged in payload?
                    optionChanged: payload.newOption != null
                });
            },

            update(this: ECharts, payload: Payload, updateParams: UpdateLifecycleParams): void {
                const ecModel = this._model;
                const api = this._api;
                const zr = this._zr;
                const coordSysMgr = this._coordSysMgr;
                const scheduler = this._scheduler;

                // update before setOption
                if (!ecModel) {
                    return;
                }

                ecModel.setUpdatePayload(payload);

                scheduler.restoreData(ecModel, payload);

                scheduler.performSeriesTasks(ecModel);

                // TODO
                // Save total ecModel here for undo/redo (after restoring data and before processing data).
                // Undo (restoration of total ecModel) can be carried out in 'action' or outside API call.

                // Create new coordinate system each update
                // In LineView may save the old coordinate system and use it to get the original point.
                coordSysMgr.create(ecModel, api);

                scheduler.performDataProcessorTasks(ecModel, payload);

                // Current stream render is not supported in data process. So we can update
                // stream modes after data processing, where the filtered data is used to
                // determine whether to use progressive rendering.
                updateStreamModes(this, ecModel);

                // We update stream modes before coordinate system updated, then the modes info
                // can be fetched when coord sys updating (consider the barGrid extent fix). But
                // the drawback is the full coord info can not be fetched. Fortunately this full
                // coord is not required in stream mode updater currently.
                coordSysMgr.update(ecModel, api);

                clearColorPalette(ecModel);
                scheduler.performVisualTasks(ecModel, payload);

                // Set background and dark mode before rendering, because they affect auto-color-determination
                // in zrender Text, and consequently affect the bounding rect if stroke is added.
                const backgroundColor = ecModel.get('backgroundColor') || 'transparent';
                zr.setBackgroundColor(backgroundColor);
                // Force set dark mode.
                const darkMode = ecModel.get('darkMode');
                if (darkMode != null && darkMode !== 'auto') {
                    zr.setDarkMode(darkMode);
                }

                render(this, ecModel, api, payload, updateParams);

                lifecycle.trigger('afterupdate', ecModel, api);
            },

            updateTransform(this: ECharts, payload: Payload): void {
                const ecModel = this._model;
                const api = this._api;

                // update before setOption
                if (!ecModel) {
                    return;
                }

                ecModel.setUpdatePayload(payload);

                // ChartView.markUpdateMethod(payload, 'updateTransform');

                const componentDirtyList = [];
                ecModel.eachComponent((componentType, componentModel) => {
                    if (componentType === 'series') {
                        return;
                    }

                    const componentView = this.getViewOfComponentModel(componentModel);
                    if (componentView && componentView.__alive) {
                        if (componentView.updateTransform) {
                            const result = componentView.updateTransform(componentModel, ecModel, api, payload);
                            result && result.update && componentDirtyList.push(componentView);
                        }
                        else {
                            componentDirtyList.push(componentView);
                        }
                    }
                });

                const seriesDirtyMap = createHashMap();
                ecModel.eachSeries((seriesModel) => {
                    const chartView = this._chartsMap[seriesModel.__viewId];
                    if (chartView.updateTransform) {
                        const result = chartView.updateTransform(seriesModel, ecModel, api, payload);
                        result && result.update && seriesDirtyMap.set(seriesModel.uid, 1);
                    }
                    else {
                        seriesDirtyMap.set(seriesModel.uid, 1);
                    }
                });

                clearColorPalette(ecModel);
                // Keep pipe to the exist pipeline because it depends on the render task of the full pipeline.
                // this._scheduler.performVisualTasks(ecModel, payload, 'layout', true);
                this._scheduler.performVisualTasks(
                    ecModel, payload, {setDirty: true, dirtyMap: seriesDirtyMap}
                );

                // Currently, not call render of components. Geo render cost a lot.
                // renderComponents(ecIns, ecModel, api, payload, componentDirtyList);
                renderSeries(this, ecModel, api, payload, {}, seriesDirtyMap);

                lifecycle.trigger('afterupdate', ecModel, api);
            },

            updateView(this: ECharts, payload: Payload): void {
                const ecModel = this._model;

                // update before setOption
                if (!ecModel) {
                    return;
                }

                ecModel.setUpdatePayload(payload);

                ChartView.markUpdateMethod(payload, 'updateView');

                clearColorPalette(ecModel);

                // Keep pipe to the exist pipeline because it depends on the render task of the full pipeline.
                this._scheduler.performVisualTasks(ecModel, payload, {setDirty: true});

                render(this, ecModel, this._api, payload, {});

                lifecycle.trigger('afterupdate', ecModel, this._api);
            },

            updateVisual(this: ECharts, payload: Payload): void {
                // updateMethods.update.call(this, payload);

                const ecModel = this._model;

                // update before setOption
                if (!ecModel) {
                    return;
                }

                ecModel.setUpdatePayload(payload);

                // clear all visual
                ecModel.eachSeries(function (seriesModel) {
                    seriesModel.getData().clearAllVisual();
                });

                // Perform visual
                ChartView.markUpdateMethod(payload, 'updateVisual');

                clearColorPalette(ecModel);

                // Keep pipe to the exist pipeline because it depends on the render task of the full pipeline.
                this._scheduler.performVisualTasks(ecModel, payload, {visualType: 'visual', setDirty: true});

                ecModel.eachComponent((componentType, componentModel) => {  // TODO componentType may be series.
                    if (componentType !== 'series') {
                        const componentView = this.getViewOfComponentModel(componentModel);
                        componentView && componentView.__alive
                            && componentView.updateVisual(componentModel, ecModel, this._api, payload);
                    }
                });

                ecModel.eachSeries((seriesModel) => {
                    const chartView = this._chartsMap[seriesModel.__viewId];
                    chartView.updateVisual(seriesModel, ecModel, this._api, payload);
                });

                lifecycle.trigger('afterupdate', ecModel, this._api);
            },

            updateLayout(this: ECharts, payload: Payload): void {
                updateMethods.update.call(this, payload);
            }
        };

        function doConvertPixelImpl(
            ecIns: ECharts,
            methodName: 'convertFromPixel',
            finder: ModelFinder,
            value: number | number[],
            opt: unknown
        ): number | number[];
        function doConvertPixelImpl(
            ecIns: ECharts,
            methodName: 'convertToPixel',
            finder: ModelFinder,
            value: CoordinateSystemDataCoord,
            opt: unknown
        ): number | number[];
        function doConvertPixelImpl(
            ecIns: ECharts,
            methodName: 'convertToLayout',
            finder: ModelFinder,
            value: CoordinateSystemDataCoord,
            opt: unknown
        ): CoordinateSystemDataLayout;
        function doConvertPixelImpl(
            ecIns: ECharts,
            methodName: 'convertFromPixel' | 'convertToPixel' | 'convertToLayout',
            finder: ModelFinder,
            value: number | number[] | CoordinateSystemDataCoord,
            opt: unknown
        ) {
            if (ecIns._disposed) {
                disposedWarning(ecIns.id);
                return;
            }
            const ecModel = ecIns._model;
            const coordSysList = ecIns._coordSysMgr.getCoordinateSystems();
            let result;

            const parsedFinder = modelUtil.parseFinder(ecModel, finder);

            for (let i = 0; i < coordSysList.length; i++) {
                const coordSys = coordSysList[i];
                if (coordSys[methodName]
                    && (result = coordSys[methodName](ecModel, parsedFinder, value as any, opt)) != null
                ) {
                    return result;
                }
            }

            if (__DEV__) {
                warn(
                    'No coordinate system that supports ' + methodName + ' found by the given finder.'
                );
            }
        };
        doConvertPixel = doConvertPixelImpl;

        updateStreamModes = function (ecIns: ECharts, ecModel: GlobalModel): void {
            const chartsMap = ecIns._chartsMap;
            const scheduler = ecIns._scheduler;
            ecModel.eachSeries(function (seriesModel) {
                scheduler.updateStreamModes(seriesModel, chartsMap[seriesModel.__viewId]);
            });
        };

        doDispatchAction = function (this: ECharts, payload: Payload, silent: boolean): void {
            const ecModel = this.getModel();
            const payloadType = payload.type;
            const escapeConnect = payload.escapeConnect;
            const actionInfo = actions[payloadType];

            const cptTypeTmp = (actionInfo.update || 'update').split(':');
            const updateMethod = cptTypeTmp.pop();
            const cptType = cptTypeTmp[0] != null && parseClassType(cptTypeTmp[0]);

            this[IN_MAIN_PROCESS_KEY] = true;
            updateMainProcessVersion(this);

            let payloads: Payload[] = [payload];
            let batched = false;
            // Batch action
            if (payload.batch) {
                batched = true;
                payloads = map<Payload['batch'][0], Payload, unknown>(payload.batch, function (item) {
                    item = defaults(extend({}, item), payload);
                    item.batch = null;
                    return item as Payload;
                });
            }

            const eventObjBatch: ECEventData[] = [];
            let eventObj: ECActionEvent;
            const actionResultBatch: ECActionEvent[] = [];
            const nonRefinedEventType = actionInfo.nonRefinedEventType;

            const isSelectChange = isSelectChangePayload(payload);
            const isHighDown = isHighDownPayload(payload);

            // Only leave blur once if there are multiple batches.
            if (isHighDown) {
                allLeaveBlur(this._api);
            }

            each(payloads, (batchItem) => {
                // Action can specify the event by return it.
                const actionResult = actionInfo.action(batchItem, ecModel, this._api) as ECActionEvent;
                if (actionInfo.refineEvent) {
                    actionResultBatch.push(actionResult);
                }
                else {
                    eventObj = actionResult;
                }
                eventObj = eventObj || extend({} as ECActionEvent, batchItem);
                eventObj.type = nonRefinedEventType;
                eventObjBatch.push(eventObj);

                // light update does not perform data process, layout and visual.
                if (isHighDown) {
                    const { queryOptionMap, mainTypeSpecified } = modelUtil.preParseFinder(payload as ModelFinder);
                    const componentMainType = mainTypeSpecified ? queryOptionMap.keys()[0] : 'series';
                    updateDirectly(this, updateMethod, batchItem as Payload, componentMainType);
                    markStatusToUpdate(this);
                }
                else if (isSelectChange) {
                    // At present `dispatchAction({ type: 'select', ... })` is not supported on components.
                    // geo still use 'geoselect'.
                    updateDirectly(this, updateMethod, batchItem as Payload, 'series');
                    markStatusToUpdate(this);
                }
                else if (cptType) {
                    updateDirectly(this, updateMethod, batchItem as Payload, cptType.main, cptType.sub);
                }
            });

            if (updateMethod !== 'none' && !isHighDown && !isSelectChange && !cptType) {
                try {
                    // Still dirty
                    if (this[PENDING_UPDATE]) {
                        prepare(this);
                        updateMethods.update.call(this, payload);
                        this[PENDING_UPDATE] = null;
                    }
                    else {
                        updateMethods[updateMethod as keyof typeof updateMethods].call(this, payload);
                    }
                }
                catch (e) {
                    this[IN_MAIN_PROCESS_KEY] = false;
                    throw e;
                }
            }

            // Follow the rule of action batch
            if (batched) {
                eventObj = {
                    type: nonRefinedEventType,
                    escapeConnect: escapeConnect,
                    batch: eventObjBatch
                };
            }
            else {
                eventObj = eventObjBatch[0] as ECActionEvent;
            }

            this[IN_MAIN_PROCESS_KEY] = false;

            if (!silent) {
                let refinedEvent: ECActionEvent;
                if (actionInfo.refineEvent) {
                    const {eventContent} = actionInfo.refineEvent(
                        actionResultBatch, payload, ecModel, this._api
                    );
                    assert(isObject(eventContent));
                    refinedEvent = defaults({type: actionInfo.refinedEventType}, eventContent);
                    refinedEvent.fromAction = payload.type;
                    refinedEvent.fromActionPayload = payload;
                    refinedEvent.escapeConnect = true;
                }

                const messageCenter = this._messageCenter;
                // - If `refineEvent` created a `refinedEvent`, `eventObj` (replicated from the original payload)
                //  is still needed to be triggered for the feature `connect`. But it will not be triggered to
                //  users in this case.
                // - If no `refineEvent` used, `eventObj` will be triggered for both `connect` and users.
                messageCenter.trigger(eventObj.type, eventObj);
                if (refinedEvent) {
                    messageCenter.trigger(refinedEvent.type, refinedEvent);
                }
            }
        };

        flushPendingActions = function (this: ECharts, silent: boolean): void {
            const pendingActions = this._pendingActions;
            while (pendingActions.length) {
                const payload = pendingActions.shift();
                doDispatchAction.call(this, payload, silent);
            }
        };

        triggerUpdatedEvent = function (this: ECharts, silent): void {
            !silent && this.trigger('updated');
        };

        /**
         * Event `rendered` is triggered when zr
         * rendered. It is useful for realtime
         * snapshot (reflect animation).
         *
         * Event `finished` is triggered when:
         * (1) zrender rendering finished.
         * (2) initial animation finished.
         * (3) progressive rendering finished.
         * (4) no pending action.
         * (5) no delayed setOption needs to be processed.
         */
        bindRenderedEvent = function (zr: zrender.ZRenderType, ecIns: ECharts): void {
            zr.on('rendered', function (params: RenderedEventParam) {

                ecIns.trigger('rendered', params);

                // The `finished` event should not be triggered repeatedly,
                // so it should only be triggered when rendering indeed happens
                // in zrender. (Consider the case that dipatchAction is keep
                // triggering when mouse move).
                if (
                    // Although zr is dirty if initial animation is not finished
                    // and this checking is called on frame, we also check
                    // animation finished for robustness.
                    zr.animation.isFinished()
                    && !ecIns[PENDING_UPDATE]
                    && !ecIns._scheduler.unfinished
                    && !ecIns._pendingActions.length
                ) {
                    ecIns.trigger('finished');
                }
            });
        };

        bindMouseEvent = function (zr: zrender.ZRenderType, ecIns: ECharts): void {
            zr.on('mouseover', function (e) {
                const el = e.target;
                const dispatcher = findEventDispatcher(el, isHighDownDispatcher);
                if (dispatcher) {
                    handleGlobalMouseOverForHighDown(dispatcher, e, ecIns._api);
                    markStatusToUpdate(ecIns);
                }
            }).on('mouseout', function (e) {
                const el = e.target;
                const dispatcher = findEventDispatcher(el, isHighDownDispatcher);
                if (dispatcher) {
                    handleGlobalMouseOutForHighDown(dispatcher, e, ecIns._api);
                    markStatusToUpdate(ecIns);
                }
            }).on('click', function (e) {
                const el = e.target;
                const dispatcher = findEventDispatcher(
                    el, (target) => getECData(target).dataIndex != null, true
                );
                if (dispatcher) {
                    const actionType = (dispatcher as ECElement).selected ? 'unselect' : 'select';
                    const ecData = getECData(dispatcher);
                    ecIns._api.dispatchAction({
                        type: actionType,
                        dataType: ecData.dataType,
                        dataIndexInside: ecData.dataIndex,
                        seriesIndex: ecData.seriesIndex,
                        isFromClick: true
                    });
                }
            });
        };

        function clearColorPalette(ecModel: GlobalModel): void {
            ecModel.clearColorPalette();
            ecModel.eachSeries(function (seriesModel) {
                seriesModel.clearColorPalette();
            });
        };

        // Allocate zlevels for series and components
        function allocateZlevels(ecModel: GlobalModel) {
            interface ZLevelItem {
                z: number,
                zlevel: number,
                idx: number,
                type: string,
                key: string
            };
            const componentZLevels: ZLevelItem[] = [];
            const seriesZLevels: ZLevelItem[] = [];
            let hasSeparateZLevel = false;
            ecModel.eachComponent(function (componentType, componentModel) {
                const zlevel = componentModel.get('zlevel') || 0;
                const z = componentModel.get('z') || 0;
                const zlevelKey = componentModel.getZLevelKey();
                hasSeparateZLevel = hasSeparateZLevel || !!zlevelKey;
                (componentType === 'series' ? seriesZLevels : componentZLevels).push({
                    zlevel,
                    z,
                    idx: componentModel.componentIndex,
                    type: componentType,
                    key: zlevelKey
                });
            });

            if (hasSeparateZLevel) {
                // Series after component
                const zLevels: ZLevelItem[] = componentZLevels.concat(seriesZLevels);
                let lastSeriesZLevel: number;
                let lastSeriesKey: string;

                timsort(zLevels, (a, b) => {
                    if (a.zlevel === b.zlevel) {
                        return a.z - b.z;
                    }
                    return a.zlevel - b.zlevel;
                });
                each(zLevels, item => {
                    const componentModel = ecModel.getComponent(item.type, item.idx);
                    let zlevel = item.zlevel;
                    const key = item.key;
                    if (lastSeriesZLevel != null) {
                        zlevel = Math.max(lastSeriesZLevel, zlevel);
                    }
                    if (key) {
                        if (zlevel === lastSeriesZLevel && key !== lastSeriesKey) {
                            zlevel++;
                        }
                        lastSeriesKey = key;
                    }
                    else if (lastSeriesKey) {
                        if (zlevel === lastSeriesZLevel) {
                            zlevel++;
                        }
                        lastSeriesKey = '';
                    }
                    lastSeriesZLevel = zlevel;
                    componentModel.setZLevel(zlevel);
                });
            }
        }

        render = (
            ecIns: ECharts, ecModel: GlobalModel, api: ExtensionAPI, payload: Payload,
            updateParams: UpdateLifecycleParams
        ) => {
            allocateZlevels(ecModel);

            renderComponents(ecIns, ecModel, api, payload, updateParams);

            each(ecIns._chartsViews, function (chart: ChartView) {
                chart.__alive = false;
            });

            renderSeries(ecIns, ecModel, api, payload, updateParams);

            // Remove groups of unrendered charts
            each(ecIns._chartsViews, function (chart: ChartView) {
                if (!chart.__alive) {
                    chart.remove(ecModel, api);
                }
            });
        };

        renderComponents = (
            ecIns: ECharts, ecModel: GlobalModel, api: ExtensionAPI, payload: Payload,
            updateParams: UpdateLifecycleParams, dirtyList?: ComponentView[]
        ) => {
            each(dirtyList || ecIns._componentsViews, function (componentView: ComponentView) {
                const componentModel = componentView.__model;
                clearStates(componentModel, componentView);

                componentView.render(componentModel, ecModel, api, payload);

                updateZ(componentModel, componentView);

                updateStates(componentModel, componentView);
            });

        };

        /**
         * Render each chart and component
         */
        renderSeries = (
            ecIns: ECharts,
            ecModel: GlobalModel,
            api: ExtensionAPI,
            payload: Payload | 'remain',
            updateParams: UpdateLifecycleParams,
            dirtyMap?: {[uid: string]: any}
        ) => {
            // Render all charts
            const scheduler = ecIns._scheduler;

            updateParams = extend(updateParams || {}, {
                updatedSeries: ecModel.getSeries()
            });

            // TODO progressive?
            lifecycle.trigger('series:beforeupdate', ecModel, api, updateParams);

            let unfinished: boolean = false;
            ecModel.eachSeries(function (seriesModel) {
                const chartView = ecIns._chartsMap[seriesModel.__viewId];
                chartView.__alive = true;

                const renderTask = chartView.renderTask;
                scheduler.updatePayload(renderTask, payload);

                // TODO states on marker.
                clearStates(seriesModel, chartView);

                if (dirtyMap && dirtyMap.get(seriesModel.uid)) {
                    renderTask.dirty();
                }
                if (renderTask.perform(scheduler.getPerformArgs(renderTask))) {
                    unfinished = true;
                }

                chartView.group.silent = !!seriesModel.get('silent');
                // Should not call markRedraw on group, because it will disable zrender
                // incremental render (always render from the __startIndex each frame)
                // chartView.group.markRedraw();

                updateBlend(seriesModel, chartView);

                updateSeriesElementSelection(seriesModel);
            });

            scheduler.unfinished = unfinished || scheduler.unfinished;

            lifecycle.trigger('series:layoutlabels', ecModel, api, updateParams);

            // transition after label is layouted.
            lifecycle.trigger('series:transition', ecModel, api, updateParams);

            ecModel.eachSeries(function (seriesModel) {
                const chartView = ecIns._chartsMap[seriesModel.__viewId];
                // Update Z after labels updated. Before applying states.
                updateZ(seriesModel, chartView);

                // NOTE: Update states after label is updated.
                // label should be in normal status when layouting.
                updateStates(seriesModel, chartView);
            });

            // If use hover layer
            updateHoverLayerStatus(ecIns, ecModel);

            lifecycle.trigger('series:afterupdate', ecModel, api, updateParams);
        };

        markStatusToUpdate = function (ecIns: ECharts): void {
            ecIns[STATUS_NEEDS_UPDATE_KEY] = true;
            // Wake up zrender if it's sleep. Let it update states in the next frame.
            ecIns.getZr().wakeUp();
        };

        updateMainProcessVersion = function (ecIns: ECharts): void {
            ecIns[MAIN_PROCESS_VERSION_KEY] = (ecIns[MAIN_PROCESS_VERSION_KEY] + 1) % 1000;
        };

        applyChangedStates = function (ecIns: ECharts): void {
            if (!ecIns[STATUS_NEEDS_UPDATE_KEY]) {
                return;
            }

            ecIns.getZr().storage.traverse(function (el: ECElement) {
                // Not applied on removed elements, it may still in fading.
                if (graphic.isElementRemoved(el)) {
                    return;
                }
                applyElementStates(el);
            });

            ecIns[STATUS_NEEDS_UPDATE_KEY] = false;
        };

        function applyElementStates(el: ECElement) {
            const newStates = [];

            const oldStates = el.currentStates;
            // Keep other states.
            for (let i = 0; i < oldStates.length; i++) {
                const stateName = oldStates[i];
                if (!(stateName === 'emphasis' || stateName === 'blur' || stateName === 'select')) {
                    newStates.push(stateName);
                }
            }

            // Only use states when it's exists.
            if (el.selected && el.states.select) {
                newStates.push('select');
            }
            if (el.hoverState === HOVER_STATE_EMPHASIS && el.states.emphasis) {
                newStates.push('emphasis');
            }
            else if (el.hoverState === HOVER_STATE_BLUR && el.states.blur) {
                newStates.push('blur');
            }
            el.useStates(newStates);
        }

        function updateHoverLayerStatus(ecIns: ECharts, ecModel: GlobalModel): void {
            const zr = ecIns._zr;
            const storage = zr.storage;
            let elCount = 0;

            storage.traverse(function (el) {
                if (!el.isGroup) {
                    elCount++;
                }
            });

            if (elCount > ecModel.get('hoverLayerThreshold') && !env.node && !env.worker) {
                ecModel.eachSeries(function (seriesModel) {
                    if (seriesModel.preventUsingHoverLayer) {
                        return;
                    }
                    const chartView = ecIns._chartsMap[seriesModel.__viewId];
                    if (chartView.__alive) {
                        chartView.eachRendered((el: ECElement) => {
                            if (el.states.emphasis) {
                                el.states.emphasis.hoverLayer = true;
                            }
                        });
                    }
                });
            }
        };

        /**
         * Update chart and blend.
         */
        function updateBlend(seriesModel: SeriesModel, chartView: ChartView): void {
            const blendMode = seriesModel.get('blendMode') || null;
            chartView.eachRendered((el: Displayable) => {
                // FIXME marker and other components
                if (!el.isGroup) {
                    // DON'T mark the element dirty. In case element is incremental and don't want to rerender.
                    el.style.blend = blendMode;
                }
            });
        };

        function updateZ(model: ComponentModel, view: ComponentView | ChartView): void {
            if (model.preventAutoZ) {
                return;
            }
            const zInfo = graphic.retrieveZInfo(model);
            // Set z and zlevel
            view.eachRendered((el) => {
                graphic.traverseUpdateZ(el, zInfo.z, zInfo.zlevel);
                // Don't traverse the children because it has been traversed in _updateZ.
                return true;
            });
        };

        // Clear states without animation.
        // TODO States on component.
        function clearStates(model: ComponentModel, view: ComponentView | ChartView): void {
            view.eachRendered(function (el: Displayable) {
                // Not applied on removed elements, it may still in fading.
                if (graphic.isElementRemoved(el)) {
                    return;
                }

                const textContent = el.getTextContent();
                const textGuide = el.getTextGuideLine();
                if (el.stateTransition) {
                    el.stateTransition = null;
                }
                if (textContent && textContent.stateTransition) {
                    textContent.stateTransition = null;
                }
                if (textGuide && textGuide.stateTransition) {
                    textGuide.stateTransition = null;
                }

                // TODO If el is incremental.
                if (el.hasState()) {
                    el.prevStates = el.currentStates;
                    el.clearStates();
                }
                else if (el.prevStates) {
                    el.prevStates = null;
                }
            });
        }

        function updateStates(model: ComponentModel, view: ComponentView | ChartView): void {
            const stateAnimationModel = (model as SeriesModel).getModel('stateAnimation');
            const enableAnimation = model.isAnimationEnabled();
            const duration = stateAnimationModel.get('duration');
            const stateTransition = duration > 0 ? {
                duration,
                delay: stateAnimationModel.get('delay'),
                easing: stateAnimationModel.get('easing')
                // additive: stateAnimationModel.get('additive')
            } : null;
            view.eachRendered(function (el: Displayable) {
                if (el.states && el.states.emphasis) {
                    // Not applied on removed elements, it may still in fading.
                    if (graphic.isElementRemoved(el)) {
                        return;
                    }

                    if (el instanceof graphic.Path) {
                        savePathStates(el);
                    }

                    // Only updated on changed element. In case element is incremental and don't want to rerender.
                    // TODO, a more proper way?
                    if (el.__dirty) {
                        const prevStates = el.prevStates;
                        // Restore states without animation
                        if (prevStates) {
                            el.useStates(prevStates);
                        }
                    }

                    // Update state transition and enable animation again.
                    if (enableAnimation) {
                        el.stateTransition = stateTransition;
                        const textContent = el.getTextContent();
                        const textGuide = el.getTextGuideLine();
                        // TODO Is it necessary to animate label?
                        if (textContent) {
                            textContent.stateTransition = stateTransition;
                        }
                        if (textGuide) {
                            textGuide.stateTransition = stateTransition;
                        }
                    }

                    // Use highlighted and selected flag to toggle states.
                    if (el.__dirty) {
                        applyElementStates(el);
                    }
                }
            });
        };

        createExtensionAPI = function (ecIns: ECharts): ExtensionAPI {
            return new (class extends ExtensionAPI {
                getCoordinateSystems(): CoordinateSystemMaster[] {
                    return ecIns._coordSysMgr.getCoordinateSystems();
                }
                getComponentByElement(el: Element) {
                    while (el) {
                        const modelInfo = (el as ViewRootGroup).__ecComponentInfo;
                        if (modelInfo != null) {
                            return ecIns._model.getComponent(modelInfo.mainType, modelInfo.index);
                        }
                        el = el.parent;
                    }
                }
                enterEmphasis(el: Element, highlightDigit?: number) {
                    enterEmphasis(el, highlightDigit);
                    markStatusToUpdate(ecIns);
                }
                leaveEmphasis(el: Element, highlightDigit?: number) {
                    leaveEmphasis(el, highlightDigit);
                    markStatusToUpdate(ecIns);
                }
                enterBlur(el: Element) {
                    enterBlur(el);
                    markStatusToUpdate(ecIns);
                }
                leaveBlur(el: Element) {
                    leaveBlur(el);
                    markStatusToUpdate(ecIns);
                }
                enterSelect(el: Element) {
                    enterSelect(el);
                    markStatusToUpdate(ecIns);
                }
                leaveSelect(el: Element) {
                    leaveSelect(el);
                    markStatusToUpdate(ecIns);
                }
                getModel(): GlobalModel {
                    return ecIns.getModel();
                }
                getViewOfComponentModel(componentModel: ComponentModel): ComponentView {
                    return ecIns.getViewOfComponentModel(componentModel);
                }
                getViewOfSeriesModel(seriesModel: SeriesModel): ChartView {
                    return ecIns.getViewOfSeriesModel(seriesModel);
                }
                getMainProcessVersion(): number {
                    return ecIns[MAIN_PROCESS_VERSION_KEY];
                }
            })(ecIns);
        };

        enableConnect = function (chart: ECharts): void {

            function updateConnectedChartsStatus(charts: ECharts[], status: ConnectStatus) {
                for (let i = 0; i < charts.length; i++) {
                    const otherChart = charts[i];
                    otherChart[CONNECT_STATUS_KEY] = status;
                }
            }

            each(connectionEventRevertMap, function (_, eventType) {
                chart._messageCenter.on(eventType, function (event: ECActionEvent) {
                    if (connectedGroups[chart.group] && chart[CONNECT_STATUS_KEY] !== CONNECT_STATUS_PENDING) {
                        if (event && event.escapeConnect) {
                            return;
                        }

                        const action = chart.makeActionFromEvent(event);
                        const otherCharts: ECharts[] = [];

                        each(instances, function (otherChart) {
                            if (otherChart !== chart && otherChart.group === chart.group) {
                                otherCharts.push(otherChart);
                            }
                        });

                        updateConnectedChartsStatus(otherCharts, CONNECT_STATUS_PENDING);
                        each(otherCharts, function (otherChart) {
                            if (otherChart[CONNECT_STATUS_KEY] !== CONNECT_STATUS_UPDATING) {
                                otherChart.dispatchAction(action);
                            }
                        });
                        updateConnectedChartsStatus(otherCharts, CONNECT_STATUS_UPDATED);
                    }
                });
            });
        };
    })();
}

const echartsProto = ECharts.prototype;
echartsProto.on = createRegisterEventWithLowercaseECharts('on');
echartsProto.off = createRegisterEventWithLowercaseECharts('off');
/**
 * @deprecated
 */
// @ts-ignore
echartsProto.one = function (eventName: string, cb: Function, ctx?: any) {
    const self = this;
    deprecateLog('ECharts#one is deprecated.');
    function wrapped(this: unknown, ...args2: any) {
        cb && cb.apply && cb.apply(this, args2);
        // @ts-ignore
        self.off(eventName, wrapped);
    };
    // @ts-ignore
    this.on.call(this, eventName, wrapped, ctx);
};

const MOUSE_EVENT_NAMES: ZRElementEventName[] = [
    'click', 'dblclick', 'mouseover', 'mouseout', 'mousemove',
    'mousedown', 'mouseup', 'globalout', 'contextmenu'
];

function disposedWarning(id: string): void {
    if (__DEV__) {
        warn('Instance ' + id + ' has been disposed');
    }
}

/**
 * @see {ActionInfo}
 */
type ActionInfoParsed = {
    actionType: string;
    nonRefinedEventType: string;
    refinedEventType: string;
    update: ActionInfo['update'];
    action: ActionInfo['action'];
    refineEvent: ActionInfo['refineEvent'];
};
const actions: {
    [actionType: string]: ActionInfoParsed
} = {};

/**
 * Map event type to action type for reproducing action from event for `connect`.
 */
const connectionEventRevertMap: {[eventType: string]: string} = {};
/**
 * To remove duplication.
 */
const publicEventTypeMap: {[eventType: string]: 1} = {};

const dataProcessorFuncs: StageHandlerInternal[] = [];

const optionPreprocessorFuncs: OptionPreprocessor[] = [];

const visualFuncs: StageHandlerInternal[] = [];

const themeStorage: {[themeName: string]: ThemeOption} = {};

const loadingEffects: {[effectName: string]: LoadingEffectCreator} = {};

const instances: {[id: string]: ECharts} = {};
const connectedGroups: {[groupId: string]: boolean} = {};

let idBase: number = +(new Date()) - 0;
let groupIdBase: number = +(new Date()) - 0;
const DOM_ATTRIBUTE_KEY = '_echarts_instance_';


/**
 * @param opts.devicePixelRatio Use window.devicePixelRatio by default
 * @param opts.renderer Can choose 'canvas' or 'svg' to render the chart.
 * @param opts.width Use clientWidth of the input `dom` by default.
 *        Can be 'auto' (the same as null/undefined)
 * @param opts.height Use clientHeight of the input `dom` by default.
 *        Can be 'auto' (the same as null/undefined)
 * @param opts.locale Specify the locale.
 * @param opts.useDirtyRect Enable dirty rectangle rendering or not.
 */
export function init(
    dom?: HTMLElement | null,
    theme?: string | object | null,
    opts?: EChartsInitOpts
): EChartsType {
    const isClient = !(opts && opts.ssr);
    if (isClient) {
        if (__DEV__) {
            if (!dom) {
                throw new Error('Initialize failed: invalid dom.');
            }
        }

        const existInstance = getInstanceByDom(dom);
        if (existInstance) {
            if (__DEV__) {
                warn('There is a chart instance already initialized on the dom.');
            }
            return existInstance;
        }

        if (__DEV__) {
            if (isDom(dom)
                && dom.nodeName.toUpperCase() !== 'CANVAS'
                && (
                    (!dom.clientWidth && (!opts || opts.width == null))
                    || (!dom.clientHeight && (!opts || opts.height == null))
                )
            ) {
                warn('Can\'t get DOM width or height. Please check '
                + 'dom.clientWidth and dom.clientHeight. They should not be 0.'
                + 'For example, you may need to call this in the callback '
                + 'of window.onload.');
            }
        }
    }

    const chart = new ECharts(dom, theme, opts);
    chart.id = 'ec_' + idBase++;
    instances[chart.id] = chart;

    isClient && modelUtil.setAttribute(dom, DOM_ATTRIBUTE_KEY, chart.id);

    enableConnect(chart);

    lifecycle.trigger('afterinit', chart);

    return chart;
}

/**
 * @usage
 * (A)
 * ```js
 * let chart1 = echarts.init(dom1);
 * let chart2 = echarts.init(dom2);
 * chart1.group = 'xxx';
 * chart2.group = 'xxx';
 * echarts.connect('xxx');
 * ```
 * (B)
 * ```js
 * let chart1 = echarts.init(dom1);
 * let chart2 = echarts.init(dom2);
 * echarts.connect('xxx', [chart1, chart2]);
 * ```
 */
export function connect(groupId: string | EChartsType[]): string {
    // Is array of charts
    if (isArray(groupId)) {
        const charts = groupId;
        groupId = null;
        // If any chart has group
        each(charts, function (chart) {
            if (chart.group != null) {
                groupId = chart.group;
            }
        });
        groupId = groupId || ('g_' + groupIdBase++);
        each(charts, function (chart) {
            chart.group = groupId as string;
        });
    }
    connectedGroups[groupId as string] = true;
    return groupId as string;
}

export function disconnect(groupId: string): void {
    connectedGroups[groupId] = false;
}

/**
 * Alias and backward compatibility
 * @deprecated
 */
export const disConnect = disconnect;

/**
 * Dispose a chart instance
 */
export function dispose(chart: EChartsType | HTMLElement | string): void {
    if (isString(chart)) {
        chart = instances[chart];
    }
    else if (!(chart instanceof ECharts)) {
        // Try to treat as dom
        chart = getInstanceByDom(chart);
    }
    if ((chart instanceof ECharts) && !chart.isDisposed()) {
        chart.dispose();
    }
}

export function getInstanceByDom(dom: HTMLElement): EChartsType | undefined {
    return instances[modelUtil.getAttribute(dom, DOM_ATTRIBUTE_KEY)];
}

export function getInstanceById(key: string): EChartsType | undefined {
    return instances[key];
}

/**
 * Register theme
 */
export function registerTheme(name: string, theme: ThemeOption): void {
    themeStorage[name] = theme;
}

/**
 * Register option preprocessor
 */
export function registerPreprocessor(preprocessorFunc: OptionPreprocessor): void {
    if (indexOf(optionPreprocessorFuncs, preprocessorFunc) < 0) {
        optionPreprocessorFuncs.push(preprocessorFunc);
    }
}

export function registerProcessor(
    priority: number | StageHandler | StageHandlerOverallReset,
    processor?: StageHandler | StageHandlerOverallReset
): void {
    normalizeRegister(dataProcessorFuncs, priority, processor, PRIORITY_PROCESSOR_DEFAULT);
}


/**
 * Register postIniter
 * @param {Function} postInitFunc
 */
export function registerPostInit(postInitFunc: PostIniter): void {
    registerUpdateLifecycle('afterinit', postInitFunc);
}

/**
 * Register postUpdater
 * @param {Function} postUpdateFunc
 */
export function registerPostUpdate(postUpdateFunc: PostUpdater): void {
    registerUpdateLifecycle('afterupdate', postUpdateFunc);
}

export function registerUpdateLifecycle<T extends keyof LifecycleEvents>(
    name: T, cb: (...args: LifecycleEvents[T]) => void
): void {
    (lifecycle as any).on(name, cb);
}

/**
 * @usage
 * registerAction('someAction', 'someEvent', function () { ... });
 * registerAction('someAction', function () { ... });
 * registerAction(
 *     {type: 'someAction', event: 'someEvent', update: 'updateView'},
 *     function () { ... }
 * );
 * registerAction({
 *     type: 'someAction',
 *     event: 'someEvent',
 *     update: 'updateView'
 *     action: function () { ... }
 *     refineEvent: function () { ... }
 * });
 * @see {ActionInfo} for more details.
 */
export function registerAction(type: string, eventType: string, action: ActionHandler): void;
export function registerAction(type: string, action: ActionHandler): void;
export function registerAction(actionInfo: ActionInfo, action?: ActionHandler): void;
export function registerAction(
    arg0: string | ActionInfo,
    arg1: string | ActionHandler,
    action?: ActionHandler
): void {
    let actionType: ActionInfo['type'];
    let publicEventType: ActionInfo['event'];
    let refineEvent: ActionInfo['refineEvent'];
    let update: ActionInfo['update'];
    let publishNonRefinedEvent: ActionInfo['publishNonRefinedEvent'];

    if (isFunction(arg1)) {
        action = arg1;
        arg1 = '';
    }

    if (isObject(arg0)) {
        actionType = arg0.type;
        publicEventType = arg0.event;
        update = arg0.update;
        publishNonRefinedEvent = arg0.publishNonRefinedEvent;
        if (!action) {
            action = arg0.action;
        }
        refineEvent = arg0.refineEvent;
    }
    else {
        actionType = arg0;
        publicEventType = arg1;
    }

    function createEventType(actionOrEventType: string) {
        // Event type should be all lowercase
        return actionOrEventType.toLowerCase();
    }

    publicEventType = createEventType(publicEventType || actionType);
    // See comments on {ActionInfo} for the reason.
    const nonRefinedEventType = refineEvent ? createEventType(actionType) : publicEventType;

    // Support calling `registerAction` multiple times with the same action
    // type; subsequent calls have no effect.
    if (actions[actionType]) {
        return;
    }

    // Validate action type and event name.
    assert(ACTION_REG.test(actionType) && ACTION_REG.test(publicEventType));
    if (refineEvent) {
        // An event replicated from the action will be triggered internally for `connect` in this case.
        assert(publicEventType !== actionType);
    }

    actions[actionType] = {
        actionType,
        refinedEventType: publicEventType,
        nonRefinedEventType,
        update,
        action,
        refineEvent,
    };

    publicEventTypeMap[publicEventType] = 1;
    if (refineEvent && publishNonRefinedEvent) {
        publicEventTypeMap[nonRefinedEventType] = 1;
    }

    if (__DEV__ && connectionEventRevertMap[nonRefinedEventType]) {
        error(`${nonRefinedEventType} must not be shared; use "refineEvent" if you intend to share an event name.`);
    }
    connectionEventRevertMap[nonRefinedEventType] = actionType;
}

export function registerCoordinateSystem(
    type: string,
    coordSysCreator: CoordinateSystemCreator
): void {
    CoordinateSystemManager.register(type, coordSysCreator);
}

/**
 * Get dimensions of specified coordinate system.
 * @param {string} type
 * @return {Array.<string|Object>}
 */
export function getCoordinateSystemDimensions(type: string): DimensionDefinitionLoose[] {
    const coordSysCreator = CoordinateSystemManager.get(type);
    if (coordSysCreator) {
        return coordSysCreator.getDimensionsInfo
            ? coordSysCreator.getDimensionsInfo()
            : coordSysCreator.dimensions.slice();
    }
}

export function registerCustomSeries(seriesType: string, renderItem: CustomSeriesRenderItem) {
    registerCustom(seriesType, renderItem);
}

export {registerLocale} from './locale';

/**
 * Layout is a special stage of visual encoding
 * Most visual encoding like color are common for different chart
 * But each chart has it's own layout algorithm
 */
function registerLayout(priority: number, layoutTask: StageHandler | StageHandlerOverallReset): void;
function registerLayout(layoutTask: StageHandler | StageHandlerOverallReset): void;
function registerLayout(
    priority: number | StageHandler | StageHandlerOverallReset,
    layoutTask?: StageHandler | StageHandlerOverallReset
): void {
    normalizeRegister(visualFuncs, priority, layoutTask, PRIORITY_VISUAL_LAYOUT, 'layout');
}

function registerVisual(priority: number, layoutTask: StageHandler | StageHandlerOverallReset): void;
function registerVisual(layoutTask: StageHandler | StageHandlerOverallReset): void;
function registerVisual(
    priority: number | StageHandler | StageHandlerOverallReset,
    visualTask?: StageHandler | StageHandlerOverallReset
): void {
    normalizeRegister(visualFuncs, priority, visualTask, PRIORITY_VISUAL_CHART, 'visual');
}

export {registerLayout, registerVisual};

const registeredTasks: (StageHandler | StageHandlerOverallReset)[] = [];

function normalizeRegister(
    targetList: StageHandler[],
    priority: number | StageHandler | StageHandlerOverallReset,
    fn: StageHandler | StageHandlerOverallReset,
    defaultPriority: number,
    visualType?: StageHandlerInternal['visualType']
): void {
    if (isFunction(priority) || isObject(priority)) {
        fn = priority as (StageHandler | StageHandlerOverallReset);
        priority = defaultPriority;
    }

    if (__DEV__) {
        if (isNaN(priority) || priority == null) {
            throw new Error('Illegal priority');
        }
        // Check duplicate
        each(targetList, function (wrap) {
            assert((wrap as StageHandlerInternal).__raw !== fn);
        });
    }

    // Already registered
    if (indexOf(registeredTasks, fn) >= 0) {
        return;
    }
    registeredTasks.push(fn);

    const stageHandler = Scheduler.wrapStageHandler(fn, visualType);

    stageHandler.__prio = priority;
    stageHandler.__raw = fn;
    targetList.push(stageHandler);
}

export function registerLoading(
    name: string,
    loadingFx: LoadingEffectCreator
): void {
    loadingEffects[name] = loadingFx;
}

/**
 * ZRender need a canvas context to do measureText.
 * But in node environment canvas may be created by node-canvas.
 * So we need to specify how to create a canvas instead of using document.createElement('canvas')
 *
 *
 * @deprecated use setPlatformAPI({ createCanvas }) instead.
 *
 * @example
 *     let Canvas = require('canvas');
 *     let echarts = require('echarts');
 *     echarts.setCanvasCreator(function () {
 *         // Small size is enough.
 *         return new Canvas(32, 32);
 *     });
 */
export function setCanvasCreator(creator: () => HTMLCanvasElement): void {
    if (__DEV__) {
        deprecateLog('setCanvasCreator is deprecated. Use setPlatformAPI({ createCanvas }) instead.');
    }
    setPlatformAPI({
        createCanvas: creator
    });
}

type RegisterMapParams = Parameters<typeof geoSourceManager.registerMap>;
/**
 * The parameters and usage: see `geoSourceManager.registerMap`.
 * Compatible with previous `echarts.registerMap`.
 */
export function registerMap(
    mapName: RegisterMapParams[0],
    geoJson: RegisterMapParams[1],
    specialAreas?: RegisterMapParams[2]
): void {
    const registerMap = getImpl('registerMap');
    registerMap && registerMap(mapName, geoJson, specialAreas);
}

export function getMap(mapName: string) {
    const getMap = getImpl('getMap');
    return getMap && getMap(mapName);
}

export const registerTransform = registerExternalTransform;

/**
 * Globa dispatchAction to a specified chart instance.
 */
// export function dispatchAction(payload: { chartId: string } & Payload, opt?: Parameters<ECharts['dispatchAction']>[1]) {
//     if (!payload || !payload.chartId) {
//         // Must have chartId to find chart
//         return;
//     }
//     const chart = instances[payload.chartId];
//     if (chart) {
//         chart.dispatchAction(payload, opt);
//     }
// }



// Builtin global visual
registerVisual(PRIORITY_VISUAL_GLOBAL, seriesStyleTask);
registerVisual(PRIORITY_VISUAL_CHART_DATA_CUSTOM, dataStyleTask);
registerVisual(PRIORITY_VISUAL_CHART_DATA_CUSTOM, dataColorPaletteTask);

registerVisual(PRIORITY_VISUAL_GLOBAL, seriesSymbolTask);
registerVisual(PRIORITY_VISUAL_CHART_DATA_CUSTOM, dataSymbolTask);

registerVisual(PRIORITY_VISUAL_DECAL, decal);

registerPreprocessor(backwardCompat);
registerProcessor(PRIORITY_PROCESSOR_DATASTACK, dataStack);
registerLoading('default', loadingDefault);

// Default actions

registerAction({
    type: HIGHLIGHT_ACTION_TYPE,
    event: HIGHLIGHT_ACTION_TYPE,
    update: HIGHLIGHT_ACTION_TYPE
}, noop);

registerAction({
    type: DOWNPLAY_ACTION_TYPE,
    event: DOWNPLAY_ACTION_TYPE,
    update: DOWNPLAY_ACTION_TYPE
}, noop);

registerAction({
    type: SELECT_ACTION_TYPE,
    event: SELECT_CHANGED_EVENT_TYPE,
    update: SELECT_ACTION_TYPE,
    action: noop,
    refineEvent: makeSelectChangedEvent,
    publishNonRefinedEvent: true, // Backward compat but deprecated.
});

registerAction({
    type: UNSELECT_ACTION_TYPE,
    event: SELECT_CHANGED_EVENT_TYPE,
    update: UNSELECT_ACTION_TYPE,
    action: noop,
    refineEvent: makeSelectChangedEvent,
    publishNonRefinedEvent: true, // Backward compat but deprecated.
});

registerAction({
    type: TOGGLE_SELECT_ACTION_TYPE,
    event: SELECT_CHANGED_EVENT_TYPE,
    update: TOGGLE_SELECT_ACTION_TYPE,
    action: noop,
    refineEvent: makeSelectChangedEvent,
    publishNonRefinedEvent: true, // Backward compat but deprecated.
});

function makeSelectChangedEvent(
    actionResultBatch: ECEventData[], payload: Payload, ecModel: GlobalModel, api: ExtensionAPI
): {eventContent: Omit<SelectChangedEvent, 'type'>} {
    return {
        eventContent: {
            selected: getAllSelectedIndices(ecModel),
            isFromClick: (payload.isFromClick as boolean) || false,
        }
    };
}

// Default theme, so that we can use `chart.setTheme('default')` to revert to
// the default theme after changing to other themes.
registerTheme('default', {});
registerTheme('dark', darkTheme);

// For backward compatibility, where the namespace `dataTool` will
// be mounted on `echarts` is the extension `dataTool` is imported.
export const dataTool = {};

export interface EChartsType extends ECharts {}
