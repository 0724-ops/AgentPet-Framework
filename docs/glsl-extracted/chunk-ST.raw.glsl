// chunk "ST" — VFX fragment shader (head)
// source chars 954690..956094 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

#include <common>
uniform float Q284;varying vec2 vUv;varying vec3 Q326;varying vec3 Q325;varying vec4 vColor;
#ifdef Q28
varying vec2 Q322;varying vec4 Q315;
#define Q37 Q322
#define Q34 Q315
#else
#define Q37 vec2(0.0)
#define Q34 vec4(0.0)
#endif
vec2 R189(vec4 R32,vec4 speed,vec4 R22,vec4 R31,vec2 R169,float custom){vec2 uv=R32.x*vUv+R32.y*Q37+R32.w*R169+speed.xy*Q284+speed.zw*custom-0.5;uv=vec2(uv.x*R22.x+uv.y*R22.z,uv.x*R22.y+uv.y*R22.w)+0.5;return uv*R31.xy+R31.zw;}vec2 R189(vec4 R32,vec4 speed,vec4 R22,vec4 R31,vec2 R169){return R189(R32,speed,R22,R31,R169,0.0);}vec4 R166(sampler2D t,vec2 uv){return texture2D(t,vec2(uv.x,1.0-uv.y));}vec4 R47(vec4 t,float on){return mix(t,vec4(1.0,1.0,1.0,t.r),on);}vec2 R63(vec4 t,float R49,float R134,float R207,float R216){float s=t.x*(1.0+R49)-R49;return R134!=0.0?(vec2(s*t.a,t.y)*2.0-1.0)*R207:s*vec2(R207,R216);}uniform float Q297;uniform float Q181;uniform float Q179;uniform float Q182;uniform float Q180;float R132(){if(Q297==0.0)return 1.0;float z=abs((viewMatrix*vec4(Q326,1.0)).z);return clamp((z-Q181)/(Q179-Q181),0.0,1.0)*clamp((z-Q182)/(Q180-Q182),0.0,1.0);}uniform float Q75;void R228(vec3 rgb,float a){rgb=clamp(rgb,0.0,1000.0);gl_FragColor=vec4(rgb,1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
vec3 R139=gl_FragColor.rgb*a;
#ifdef Q2
if(Q75==2.0)R139+=1.0-a;
#endif
gl_FragColor=vec4(R139,a*max(1.0-Q75,0.0));}

