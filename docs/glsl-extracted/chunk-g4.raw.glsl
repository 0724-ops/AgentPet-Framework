// chunk "g4" — outline fragment shader
// source chars 940297..940765 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

#include <common>
uniform sampler2D Q71;uniform vec3 Q69;uniform float Q190;uniform float Q65;uniform float Q191;uniform float Q195;uniform vec3 Q196;varying vec2 vUv;varying vec3 Q326;
${dT}
${cT}
void main(){vec4 base=R200(Q71,Q69,Q190,vUv);
#ifdef Q1
if(base.a<Q65)discard;
#endif
R223(Q326,vUv);
#ifdef Q16
gl_FragColor=vec4(Q196,1.0);
#else
gl_FragColor=vec4(R205(base.rgb,Q195)*Q191,1.0);
#endif
#include <tonemapping_fragment>
#include <colorspace_fragment>
}

