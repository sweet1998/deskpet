import { Application } from '@pixi/app'
import { extensions } from '@pixi/extensions'
import { Ticker, TickerPlugin } from '@pixi/ticker'
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4'
import type { DeskpetLive2DModel } from './types'

Live2DModel.registerTicker(Ticker)
extensions.add(TickerPlugin)
;(window as any).PIXI = (window as any).PIXI || {}
;(window as any).PIXI.Ticker = Ticker

const RESOLUTION = 2
export let modelRefW = 100
export let modelRefH = 100

export async function createPixiApp(container: HTMLElement, width: number, height: number): Promise<Application> {
  const app = new Application({
    width: width * RESOLUTION,
    height: height * RESOLUTION,
    backgroundAlpha: 0,
    preserveDrawingBuffer: false,
    resolution: 1,
    autoDensity: false,
  })
  app.stage.scale.set(RESOLUTION)

  const canvas = app.view as HTMLCanvasElement
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.objectFit = 'cover'
  canvas.style.display = 'block'
  container.appendChild(canvas)
  return app
}

export async function loadLive2DModel(modelPath: string, app: Application): Promise<DeskpetLive2DModel> {
  const model = await Live2DModel.from(
    modelPath,
    { autoInteract: false, autoUpdate: true },
  ) as DeskpetLive2DModel
  model.anchor.set(0.5, 0.5)

  const cw = app.view.width / RESOLUTION
  const ch = app.view.height / RESOLUTION
  modelRefW = model.width || 100
  modelRefH = model.height || 100

  const scale = Math.min((cw * 0.85) / modelRefW, (ch * 0.85) / modelRefH)

  model.scale.set(scale)
  model.position.set(cw / 2, ch / 2)
  app.stage.addChild(model)
  return model
}

export function playMotion(model: DeskpetLive2DModel, name: string, idx = 0) {
  try {
    model.motion(name, idx, MotionPriority.FORCE)
  } catch (err) {
    console.debug(`[Deskpet] Motion not available: ${name}[${idx}]`, err)
  }
}

export function setExpression(model: DeskpetLive2DModel, id: string) {
  try {
    model.expression(id)
  } catch (err) {
    console.debug(`[Deskpet] Expression not available: ${id}`, err)
  }
}

export function applyParameters(
  model: DeskpetLive2DModel,
  parameters: Record<string, number>,
) {
  const coreModel = model.internalModel?.coreModel
  if (!coreModel) return

  for (const [id, value] of Object.entries(parameters)) {
    try {
      coreModel.setParameterValueById(id, value)
    } catch (err) {
      console.debug(`[Deskpet] Parameter not available: ${id}`, err)
    }
  }
}

export function resizeModel(
  model: DeskpetLive2DModel,
  cw: number, ch: number,
  zoom: number = 1.0,
  fx?: number, fy?: number,
) {
  const base = Math.min((cw * 0.85) / modelRefW, (ch * 0.85) / modelRefH)
  const newScale = Math.max(0.01, Math.min(30.0, base * zoom))

  if (fx !== undefined && fy !== undefined) {
    const oldScale = model.scale.x
    if (oldScale > 0) {
      const ratio = newScale / oldScale
      model.position.set(
        fx - (fx - model.position.x) * ratio,
        fy - (fy - model.position.y) * ratio,
      )
    }
  }

  model.scale.set(newScale)
}

export function resizeModelFit(
  model: DeskpetLive2DModel,
  cw: number, ch: number,
  zoom: number = 1.0,
) {
  const base = Math.min((cw * 0.85) / modelRefW, (ch * 0.85) / modelRefH)
  const newScale = Math.max(0.01, Math.min(30.0, base * zoom))
  model.scale.set(newScale)
  model.position.set(cw / 2, ch / 2)
}
