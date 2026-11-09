// template literal at char 1021498..1023549  body length 2050  glsl-marker-hits 10
// context before: "s:{...t.defines,Q28:\"\"},uniforms:v,vertexShader:t.vertexShader,fragmentShader:Pz,side:Ez[r._CullMode??2]??An});return m.userData=s.userData,m}function Cz(s){for(const e of Object.values(s.uniforms))e.value instanceof It&&e.value.dispose();s.dispose()}const Pz="
// context after : ",Iz={view:\"Q33\",stretch:\"Q30\",axes:\"Q29\",mesh:null};function Lz(s,e,t=!1){const n={},i=Iz[s];return i&&(n[i]=\"\"),e&&(n.Q32=\"\"),t&&s===\"mesh\"&&(n.Q31=\"\"),{vertexShader:Oz,defines:n}}function Dz(){retu"
// ======================================================================

#include <common>
uniform float Q284;uniform vec3 Q184;uniform sampler2D Q70,Q201,Q204,Q203;uniform vec4 Q72,Q69,Q199,Q200;uniform float Q84,Q288,Q290;uniform float Q295,Q168,Q167;uniform float Q281,Q166,Q283,Q183,Q307;uniform float Q68,Q67,Q176,Q139,Q153;varying vec2 vUv;varying vec3 Q326;varying vec3 Q325;
#ifdef Q31
varying vec4 Q327;
#endif
vec4 R166(sampler2D t,vec2 uv){return texture2D(t,vec2(uv.x,1.0-uv.y));}void main(){vec2 R212=vUv;vec2 uv1=vUv;vec4 base=R166(Q70,R212*Q72.xy+Q72.zw);vec3 R45=mix(clamp(base.rgb*Q69.rgb*Q84,0.0,1.0),Q69.rgb,Q288);vec3 N=normalize(Q325);
#ifdef Q31
vec3 T=normalize(Q327.xyz);vec3 B= -(Q327.w>0.0?1.0: -1.0)*cross(T,N);
#else
vec3 T=normalize(cross(abs(N.y)<0.99?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0),N));vec3 B=cross(N,T);
#endif
vec3 R18=N*(gl_FrontFacing?1.0:(Q290>0.0? -1.0:1.0));vec3 V=normalize(cameraPosition-Q326);float R35=base.a*Q69.a;float m=Q295!=0.0?R35+Q295*(R166(Q203,uv1).r-R35):mix(base.a,1.0,clamp(Q168-1.0,0.0,1.0))*(1.0-Q167);vec3 R82=vec3(0.0);if(m>0.01){vec3 tv=normalize(vec3(dot(T,V),dot(B,V),dot(N,V)));vec2 o=tv.xy/(tv.z+0.42)/max(tv.z,0.001)* -Q281;vec2 R215=mix(R212,uv1,Q307);float n=min(Q166,20.0);float R196=1.0/n;vec2 delta=o*R196;vec2 R59=delta;vec2 prev=vec2(0.0);float layer=1.0-R196;float R148=1.0;float R149=0.0;float R117=0.0;bool R116=false;for(int k=1;k<=21;k++){if(float(k)>=n+1.0)break;float s=R166(Q204,R215*Q183+R59).r;if(layer<s){R117=s;R116=true;break;}prev=R59;R149=s;R148=layer;layer-=R196;R59+=delta;}if(!R116)R117=R149;float w=(R149-R148)/(R149-R117+layer-R148);vec2 offset=delta*w+prev;float p=R166(Q201,(R215+offset)*Q283).r;vec3 c=mix(Q200.rgb,Q199.rgb,p);float R80=pow(max(clamp(dot(V,R18),0.0,1.0),0.001),floor(Q139))*m*m;float R125=1.0-Q176;float b=0.5*(R125*cos(Q284*Q68*0.05+(Q184.x+Q184.y+Q184.z)*Q67)+1.0+Q176);R82=clamp(b*R80*c,0.0,1000.0)*Q153;}vec3 L=normalize(V+vec3(0.0,0.6,0.0));vec3 rgb=R45*(0.25+0.75*max(dot(R18,L),0.0))+R82;gl_FragColor=vec4(clamp(rgb,0.0,1000.0),1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}

