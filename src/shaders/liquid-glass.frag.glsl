#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uDesktop;
uniform vec2 uResolution;
uniform float uDpr;
uniform vec2 uScreenOrigin;
uniform vec2 uScreenSize;
uniform float uHasDesktop;

uniform vec4 uPanels[4];
uniform float uRadius[4];

uniform vec2 uPointer;
uniform float uRefraction;
uniform float uBlur;
uniform float uFresnel;
uniform float uOpacity;
uniform float uSaturation;
uniform float uShadow;
uniform float uTime;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 desktopAt(vec2 screenDip, float lod) {
  vec2 uv = clamp(screenDip / uScreenSize, vec2(0.001), vec2(0.999));
  uv.y = 1.0 - uv.y;
  return textureLod(uDesktop, uv, lod).rgb;
}

vec3 blurredDesktop(vec2 screenDip, float radiusDip) {
  float dipPerTexel = uScreenSize.x / float(textureSize(uDesktop, 0).x);
  float lod = clamp(log2(max(radiusDip, 1.0) / max(dipPerTexel, 0.5)), 0.0, 5.0);
  return desktopAt(screenDip, lod);
}

void main() {
  vec3 result = vec3(0.0);
  float resultAlpha = 0.0;
  float sx = gl_FragCoord.x / uDpr + uScreenOrigin.x;
  float sy = uScreenOrigin.y + (uResolution.y - gl_FragCoord.y) / uDpr;
  vec2 screenDip = vec2(sx, sy);
  vec2 pointerDip = uPointer / uDpr;

  for (int i = 0; i < 4; i++) {
    if (uPanels[i].z <= 0.0) continue;

    vec2 center = uPanels[i].xy;
    vec2 halfSize = uPanels[i].zw * 0.5;
    float radius = min(uRadius[i], min(halfSize.x, halfSize.y));
    vec2 p = gl_FragCoord.xy - center;
    float d = sdRoundBox(p, halfSize, radius);
    float isDock = smoothstep(42.0, 62.0, halfSize.y * 2.0 / uDpr);

    if (d > 1.0 * uDpr) continue;

    float coverage = 1.0 - smoothstep(0.0, 1.15 * uDpr, d);
    float depth = max(0.0, -d);

    // SDF normal and an edge-only displacement mask, matching the project's SVG map.
    float stepSize = max(0.85, uDpr * 0.7);
    float gradX = sdRoundBox(p + vec2(stepSize, 0.0), halfSize, radius)
                - sdRoundBox(p - vec2(stepSize, 0.0), halfSize, radius);
    float gradY = sdRoundBox(p + vec2(0.0, stepSize), halfSize, radius)
                - sdRoundBox(p - vec2(0.0, stepSize), halfSize, radius);
    vec2 normal = normalize(vec2(gradX, gradY) + vec2(1e-5));
    vec2 tangent = vec2(-normal.y, normal.x);

    float edgeWidth = mix(17.0, 31.0, isDock) * uDpr;
    float edgeMask = 1.0 - smoothstep(0.0, edgeWidth, depth);
    edgeMask = pow(edgeMask, 1.35);
    float edgeBand = 1.0 - smoothstep(0.0, 2.2 * uDpr, depth);

    // The library's default displacementScale is 70; this maps the config to the Dock width.
    float displacementScale = mix(20.0, 56.0, isDock)
                            * (0.55 + clamp(uRefraction, 0.0, 1.5) * 0.72);
    float liquidWave = sin(p.x * 0.042 + uTime * 0.45)
                     + 0.55 * cos(p.y * 0.071 - uTime * 0.33 + p.x * 0.012);
    vec2 bendOffset = normal * displacementScale * edgeMask * uDpr
                    + tangent * liquidWave * 1.25 * edgeMask * uDpr;

    // liquid-glass-react applies blur to the whole backdrop, then bends only the edge.
    float blurRadius = mix(7.5, 11.5, isDock) * (0.72 + clamp(uBlur, 0.0, 2.5) * 0.36);
    vec3 centerClean = blurredDesktop(screenDip, blurRadius);

    float aberration = mix(0.035, 0.085, isDock);
    vec3 redSample = blurredDesktop(screenDip + bendOffset, blurRadius);
    vec3 greenSample = blurredDesktop(screenDip + bendOffset * (1.0 - aberration * 0.5), blurRadius);
    vec3 blueSample = blurredDesktop(screenDip + bendOffset * (1.0 - aberration), blurRadius);
    vec3 edgeAberration = vec3(redSample.r, greenSample.g, blueSample.b);

    vec3 glass = mix(centerClean, edgeAberration, smoothstep(0.03, 0.92, edgeMask));
    float colorCore = smoothstep(0.2, 1.0, edgeMask);
    glass = mix(glass, glass * vec3(0.94, 0.985, 1.04), colorCore * 0.22);
    float luma = dot(glass, vec3(0.299, 0.587, 0.114));
    glass = mix(vec3(luma), glass, uSaturation);

    // On a light desktop the source project darkens the pane instead of adding a white fill.
    float lightBackground = smoothstep(0.48, 0.96, luma);
    glass *= mix(1.0, 0.865, lightBackground * 0.72);

    // Pointer-responsive double-gradient border from the React component.
    vec2 pointerLocal = (pointerDip - center / uDpr) / max(halfSize / uDpr, vec2(1.0));
    vec2 borderDir = normalize(vec2(-0.62 + pointerLocal.x * 0.12, 0.79));
    float borderSweep = dot(normalize(vec2(p.x / max(halfSize.x, 1.0), p.y / max(halfSize.y, 1.0))), borderDir) * 0.5 + 0.5;
    float borderGradient = 0.10 + 0.36 * smoothstep(0.05, 0.92, borderSweep);
    float topLift = mix(0.32, 1.0, smoothstep(-halfSize.y * 0.25, halfSize.y, p.y));
    float outline = edgeBand * borderGradient * topLift * (0.62 + uFresnel * 0.56);
    float innerGlow = exp(-depth / max(3.0 * uDpr, 1.0)) * 0.075 * topLift;

    vec3 highlight = vec3(0.93, 0.975, 1.0);
    glass = mix(glass, vec3(1.0), clamp(outline * 0.74 + innerGlow, 0.0, 0.54));
    glass += highlight * (outline * 0.17 + innerGlow * 0.28);

    // A soft top highlight mirrors the hover treatment in liquid-glass-react.
    vec2 topGlowP = p - vec2(pointerLocal.x * halfSize.x * 0.16, halfSize.y);
    float topGlow = exp(-dot(topGlowP / max(vec2(halfSize.x * 0.42, halfSize.y * 0.95), vec2(1.0)), topGlowP / max(vec2(halfSize.x * 0.42, halfSize.y * 0.95), vec2(1.0)))) * isDock;
    glass += vec3(1.0) * topGlow * 0.022;

    float alpha = clamp(0.84 + edgeMask * 0.09 + uOpacity + outline * 0.18, 0.0, 0.985) * coverage;
    if (alpha > resultAlpha) {
      resultAlpha = alpha;
      result = glass;
    }
  }

  if (resultAlpha <= 0.002) discard;
  fragColor = vec4(max(result, vec3(0.0)), resultAlpha);
}
