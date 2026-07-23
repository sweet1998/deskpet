import { describe, expect, it } from 'vitest'
import { parseMemoryIntent } from './memory-intent'

describe('explicit memory intent', () => {
  it('captures only explicit remember and name requests', () => {
    expect(parseMemoryIntent('记住我周五下午要交周报')).toEqual({
      kind: 'remember', value: '我周五下午要交周报',
    })
    expect(parseMemoryIntent('以后叫我小林')).toEqual({ kind: 'set_name', value: '小林' })
    expect(parseMemoryIntent('记住了吗')).toBeNull()
    expect(parseMemoryIntent('我周五下午要交周报')).toBeNull()
  })

  it('supports listing and scoped deletion', () => {
    expect(parseMemoryIntent('你还记得我什么')).toEqual({ kind: 'list' })
    expect(parseMemoryIntent('忘掉周五交周报这条记忆')).toEqual({ kind: 'forget', value: '周五交周报' })
    expect(parseMemoryIntent('清除全部记忆')).toEqual({ kind: 'forget_all' })
  })
})
