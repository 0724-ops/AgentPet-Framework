// template literal at char 1105209..1105825  body length 615  glsl-marker-hits 9
// context before: "in(Q253.x,Q253.y)*clip.w;vec2 R224=s*0.01;vec2 offset=vec2(abs(R224.x)<k?sign(s.x)*k:R224.x,abs(R224.y)<k?sign(s.y)*k:R224.y);gl_Position=vec4(clip.xy+offset,clip.zw);vec2 R214=vec2(uv.x,1.0-uv.y)*Q161.xy+Q161.zw;vUv=vec2(R214.x,1.0-R214.y);Q323=R219.z;}\n`,X5="
// context after : ";class Cx{constructor(e,t){R(this,\"onBeforeRender\",e=>{const t=e.getRenderTarget(),n=this.material.uniforms.Q253.value;t?n.set(t.width,t.height):e.getDrawingBufferSize(n)});this.material=e,this.textu"
// ======================================================================

uniform sampler2D Q163;uniform vec4 Q285;uniform float Q289,Q286,Q294;uniform float Q297;uniform vec4 Q178;uniform float Q64,Q125,Q124;uniform float Q280;varying vec2 vUv;varying float Q323;void main(){vec4 c=Q285*vec4(vec3(Q289),Q286);vec4 t=texture2D(Q163,vUv);t=mix(t,vec4(1.0,1.0,1.0,t.r),Q294);vec4 R58=c*t;float z=abs(Q323);float R77=Q297!=0.0?clamp((z-Q178.x)/(Q178.y-Q178.x),0.0,1.0)*clamp((z-Q178.z)/(Q178.w-Q178.z),0.0,1.0):1.0;float a=clamp(R77*R58.a,0.0,1.0);if(a<Q64)discard;vec3 rgb=clamp(max(R58.rgb-Q125,0.0)*Q124+R58.rgb,0.0,1000.0);gl_FragColor=vec4(rgb*Q280,a);
#include <colorspace_fragment>
}

