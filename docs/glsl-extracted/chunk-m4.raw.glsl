// chunk "m4" — outline vertex shader
// source chars 939127..940291 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

#include <common>
#include <skinning_pars_vertex>
uniform float Q197;uniform float Q194;uniform vec2 Q192;uniform sampler2D Q193;
#ifdef Q26
attribute vec3 Q57;
#endif
varying vec2 vUv;varying vec3 Q326;void main(){vUv=uv;
#ifdef Q26
vec3 objectNormal=Q57;
#else
vec3 objectNormal=normal;
#endif
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
Q326=(modelMatrix*vec4(transformed,1.0)).xyz;vec4 mvPosition=modelViewMatrix*vec4(transformed,1.0);gl_Position=projectionMatrix*mvPosition;vec3 n=normalize(normalMatrix*objectNormal);vec2 R140=(projectionMatrix*vec4(n,0.0)).xy;R140*=inversesqrt(max(dot(R140,R140),1e-12));R140.x*=Q192.y/Q192.x;float R104=atan(1.0/projectionMatrix[1][1]);float w=gl_Position.w;vec2 R142=R140*(0.392699/R104*Q197*clamp(w*R104*4.583663,0.0,1.0)*0.005);vec2 R151=min(max(w,0.0),1.570796/R104)/Q192;R142=mix(R142,sign(R142)*R151,vec2(lessThan(abs(R142),R151)));float R137=Q194;
#ifdef Q15
vec2 R141=texture2D(Q193,uv).rg;R142*=R141.r;R137*=R141.g;
#endif
gl_Position.xy+=R142;vec4 R152=projectionMatrix*vec4(mvPosition.xy,mvPosition.z-0.1*R137,1.0);gl_Position.z=R152.z*w/R152.w;}

