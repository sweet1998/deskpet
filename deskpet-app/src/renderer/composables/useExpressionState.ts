import { watch } from 'vue'
import { useDeskpetStore } from '@/stores/deskpet'
import { applyParameters, setExpression } from '@/services/live2d/loader'
import { getEmotionTarget } from '@/services/live2d/emotion-adapter'

const EXPRESSION_DURATION_MS = 6000

export function useExpressionState(store: ReturnType<typeof useDeskpetStore>) {
  let revertTimer: ReturnType<typeof setTimeout> | null = null
  let activeParameters: Record<string, number> | null = null
  let boundInternalModel: any = null

  function applyActiveParameters() {
    if (!activeParameters || !store.live2dModel) return
    applyParameters(store.live2dModel, activeParameters)
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

  function applyEmotionState(emotion: string) {
    const model = store.live2dModel
    if (!model) return

    const target = getEmotionTarget(store.emotionAdapter, emotion)
    activeParameters = target?.parameters ?? null
    if (!target) return

    if (target.expression) {
      setExpression(model, target.expression)
    }
    if (target.parameters) {
      applyParameters(model, target.parameters)
    }
  }

  function clearRevertTimer() {
    if (revertTimer) {
      clearTimeout(revertTimer)
      revertTimer = null
    }
  }

  function activateEmotionState(emotion: string) {
    clearRevertTimer()
    applyEmotionState(emotion)

    if (emotion !== 'neutral' && emotion !== 'idle') {
      revertTimer = setTimeout(() => {
        revertTimer = null
        store.currentEmotion = 'neutral'
      }, EXPRESSION_DURATION_MS)
    }
  }

  watch(
    () => store.currentEmotion,
    activateEmotionState,
  )

  const stopModelWatch = watch(
    () => store.live2dModel,
    bindModel,
    { immediate: true },
  )

  function cleanup() {
    clearRevertTimer()
    stopModelWatch()
    bindModel(null)
  }

  return { activateEmotionState, cleanup }
}
