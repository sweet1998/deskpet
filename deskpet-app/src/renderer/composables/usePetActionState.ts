import { watch } from 'vue'
import { useDeskpetStore } from '@/stores/deskpet'
import { applyParameters } from '@/services/live2d/loader'

type ActionFrame = Record<string, number>

const ACTION_DURATIONS: Record<string, number> = {
  wave: 1200,
  walk: 1400,
  crawl: 1500,
  jump: 900,
  roll: 1200,
  spin: 1100,
  sit: 1400,
  sleep: 1800,
  wake: 1000,
  dance: 1800,
  cheer: 1200,
}

function actionFrame(action: string, progress: number): ActionFrame | null {
  const pulse = Math.sin(Math.PI * progress)
  const wave = Math.sin(Math.PI * 4 * progress)
  const fastWave = Math.sin(Math.PI * 8 * progress)

  switch (action) {
    case 'wave':
      return { ParamArmRA: 10 * wave, ParamHandR: pulse }
    case 'walk':
      return {
        ParamLeg: (1 + wave) / 2,
        ParamBodyAngleX: 7 * wave,
        ParamShoulder: 0.45 * fastWave,
      }
    case 'crawl':
      return {
        ParamLeg: 1 - pulse,
        ParamBodyAngleY: 10 * pulse,
        ParamArmLA: 8 * wave,
        ParamArmRA: -8 * wave,
      }
    case 'jump':
      return {
        ParamLeg: progress < 0.5 ? 0 : 1,
        ParamShoulder: -pulse,
        ParamBodyAngleY: 10 * pulse,
        ParamAngleY: -12 * pulse,
      }
    case 'roll':
      return {
        ParamAngleZ: 30 * Math.sin(Math.PI * 2 * progress),
        ParamBodyAngleZ: 10 * wave,
        ParamArmLA: 10 * wave,
        ParamArmRA: -10 * wave,
      }
    case 'spin':
      return {
        ParamAngleZ: 30 * Math.sin(Math.PI * 2 * progress),
        ParamBodyAngleX: 10 * wave,
        ParamBodyAngleZ: 10 * Math.sin(Math.PI * 2 * progress),
      }
    case 'sit':
      return {
        ParamLeg: 1 - pulse,
        ParamBodyAngleY: -10 * pulse,
        ParamShoulder: 0.8 * pulse,
      }
    case 'sleep':
      return {
        ParamEyeLOpen: 1 - pulse,
        ParamEyeROpen: 1 - pulse,
        ParamAngleZ: -25 * pulse,
        ParamBodyAngleX: -8 * pulse,
        ParamMouthForm: -0.4 * pulse,
      }
    case 'wake':
      return {
        ParamEyeLOpen: 0.2 + pulse,
        ParamEyeROpen: 0.2 + pulse,
        ParamBodyAngleY: 10 * wave,
        ParamMouthOpenY: 0.6 * pulse,
      }
    case 'dance':
      return {
        ParamBodyAngleX: 10 * wave,
        ParamBodyAngleZ: 10 * fastWave,
        ParamArmLA: 10 * fastWave,
        ParamArmRA: -10 * fastWave,
        ParamShoulder: 0.7 * wave,
      }
    case 'cheer':
      return {
        ParamArmLA: 10 * pulse,
        ParamArmRA: 10 * pulse,
        ParamHandL: pulse,
        ParamHandR: pulse,
        ParamMouthOpenY: 0.8 * pulse,
        ParamBodyAngleY: 8 * wave,
      }
    default:
      return null
  }
}

export function usePetActionState(store: ReturnType<typeof useDeskpetStore>) {
  let activeParameters: ActionFrame | null = null
  let timer: number | null = null
  let boundInternalModel: any = null

  function applyActiveParameters() {
    if (!activeParameters || !store.live2dModel) return
    applyParameters(store.live2dModel, activeParameters)
  }

  function stopAction() {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    activeParameters = null
  }

  function bindModel(model: typeof store.live2dModel) {
    if (boundInternalModel) {
      boundInternalModel.off('beforeModelUpdate', applyActiveParameters)
      boundInternalModel = null
    }
    if (!model?.internalModel) return
    boundInternalModel = model.internalModel
    boundInternalModel.on('beforeModelUpdate', applyActiveParameters)
  }

  function playActionEffect(action: string, loop = false): boolean {
    const duration = ACTION_DURATIONS[action]
    if (!duration || !actionFrame(action, 0)) return false

    stopAction()
    const startedAt = performance.now()
    activeParameters = actionFrame(action, 0)
    timer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt
      const progress = loop ? (elapsed % duration) / duration : Math.min(1, elapsed / duration)
      activeParameters = actionFrame(action, progress)
      if (!loop && progress >= 1) stopAction()
    }, 16)
    return true
  }

  const stopModelWatch = watch(
    () => store.live2dModel,
    bindModel,
    { immediate: true },
  )

  function cleanup() {
    stopAction()
    stopModelWatch()
    bindModel(null)
  }

  return { playActionEffect, stopActionEffect: stopAction, cleanup }
}
