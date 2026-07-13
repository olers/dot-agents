/**
 * 收敛的三拍。
 *
 *   plan       计划态。左边散着，右边是预览（虚线、压暗）。
 *   collapsing 左边的条目折叠成一行软链。线全部退场 ——
 *              折叠期间接线柱一路在漂移，线留着只会甩得到处都是。
 *   linking    折叠落定，锚点稳了。线按「每目录一条」重画，两侧转墨绿。
 *   done       出结果。图留着，收敛后的样子得看得见。
 */
export type Phase = 'plan' | 'collapsing' | 'linking' | 'done'

/** 折叠动画跑完的时间，跟 styles.css 里 .entries / .linkrow 的 transition 对齐。 */
export const COLLAPSE_MS = 700

/** 从点下按钮到出结果。留够时间让线画完，否则收敛这件事一闪而过。 */
export const CONVERGE_MS = 1900
