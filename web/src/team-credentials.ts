/**
 * 一次性团队接入串在签发后渲染于团队页画布顶部，而管理员通常在页面下方的
 * "成员管理"发起操作。凭据离开视口时用户会以为没有生成，因此这里给出是否需要
 * 把卡片滚入视口的纯判定，便于脱离 DOM 测试。
 */
export interface RevealCardRect {
	top: number;
	bottom: number;
}

export interface ViewportMetrics {
	height: number;
}

/**
 * 仅当卡片没有完整落在视口内时才需要滚动。已经可见时保持当前滚动位置，
 * 避免用户正在阅读的内容被无谓地移动。
 */
export function shouldRevealCredentialCard(
	rect: RevealCardRect,
	viewport: ViewportMetrics,
): boolean {
	return rect.top < 0 || rect.bottom > viewport.height;
}
