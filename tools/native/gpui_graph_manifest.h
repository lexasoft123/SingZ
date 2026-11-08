#pragma once
// Private startup projection. No JSON interpretation, graph migration or raw
// adapter state enters this bridge. Native prepare owns semantic admission.
#include <limits>

bool readGpuiGraphManifest(const std::string& path, singz::NativePlaybackGraphDocument& result) {
  auto file=openManifestSource(path);if(!file.valid())return false;
  constexpr size_t maximum=8*1024*1024;
  std::string bytes;std::array<char,4096> buffer{};
  for(;;){
#if defined(_WIN32)
    const auto count=_read(file.get(),buffer.data(),static_cast<unsigned>(buffer.size()));
#else
    const auto count=::read(file.get(),buffer.data(),buffer.size());
#endif
    if(count<0){if(errno==EINTR)continue;return false;}if(count==0)break;
    if(static_cast<size_t>(count)>maximum-bytes.size())return false;
    bytes.append(buffer.data(),static_cast<size_t>(count));
  }
  std::istringstream source(bytes);std::string line;
  auto next=[&](std::istringstream& input,const char* expected){
    if(!std::getline(source,line)||line.size()>4096)return false;
    input.clear();input.str(line);std::string tag;input>>tag;return tag==expected;
  };
  auto end=[](std::istringstream& input){input>>std::ws;return input.eof();};
  auto number=[](std::istringstream& input,uint64_t maximum,uint64_t& out){
    std::string token;if(!(input>>token)||token.empty()||(token.size()>1&&token[0]=='0')||token.size()>20)return false;
    const auto parsed=std::from_chars(token.data(),token.data()+token.size(),out);
    return parsed.ec==std::errc{}&&parsed.ptr==token.data()+token.size()&&out<=maximum;
  };
  auto text=[](std::istringstream& input,std::string& out){std::string hex;return static_cast<bool>(input>>hex)&&decodeManifestText(hex,128,out);};
  std::istringstream row;uint64_t nodes=0,edges=0;
  if(!next(row,"SingZGraph1")||!number(row,128,nodes)||nodes==0||!number(row,256,edges)||!end(row))return false;
  singz::NativePlaybackGraphDocument graph;
  for(uint64_t i=0;i<nodes;++i){
    singz::NativePlaybackGraphNode node;std::string type;uint64_t version=0,policy=0,inputs=0,outputs=0,parameters=0,binding=0;
    if(!next(row,"node")||!number(row,UINT64_MAX,node.id)||node.id==0||!(row>>type)||type.size()!=32||
       !std::all_of(type.begin(),type.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');})||
       !number(row,UINT32_MAX,version)||version==0||!text(row,node.execution)||!number(row,1,policy)||
       !number(row,16,inputs)||!number(row,16,outputs)||!number(row,64,parameters)||!number(row,1,binding)||!end(row))return false;
    const auto high=std::from_chars(type.data(),type.data()+16,node.type.high,16);
    const auto low=std::from_chars(type.data()+16,type.data()+32,node.type.low,16);
    if(high.ec!=std::errc{}||low.ec!=std::errc{})return false;
    node.typeVersion=static_cast<uint32_t>(version);
    node.unavailable=policy?singz::NativePlaybackGraphUnavailablePolicy::Silence:singz::NativePlaybackGraphUnavailablePolicy::Bypass;
    for(uint64_t p=0;p<inputs+outputs;++p){
      singz::NativePlaybackGraphPort port;uint64_t channels=0;
      if(!next(row,"port")||!text(row,port.id)||!number(row,64,channels)||channels==0||!end(row))return false;
      port.channels=static_cast<uint32_t>(channels);(p<inputs?node.inputs:node.outputs).push_back(std::move(port));
    }
    for(uint64_t p=0;p<parameters;++p){
      singz::NativePlaybackGraphParameter parameter;
      if(!next(row,"param")||!text(row,parameter.id)||!(row>>parameter.normalizedValue)||!std::isfinite(parameter.normalizedValue)||
         parameter.normalizedValue<0||parameter.normalizedValue>1||!end(row))return false;
      node.parameters.push_back(std::move(parameter));
    }
    if(binding){singz::NativePlaybackGraphBinding value;std::string lane;
      if(!next(row,"binding")||!text(row,value.kind)||!(row>>lane)||!end(row))return false;
      if(lane!="-"&&!decodeManifestText(lane,128,value.laneId))return false;
      node.binding=std::move(value);
    }
    graph.nodes.push_back(std::move(node));
  }
  for(uint64_t e=0;e<edges;++e){singz::NativePlaybackGraphConnection edge;
    if(!next(row,"edge")||!number(row,UINT64_MAX,edge.from.node)||edge.from.node==0||!text(row,edge.from.port)||
       !number(row,UINT64_MAX,edge.to.node)||edge.to.node==0||!text(row,edge.to.port)||!end(row))return false;
    graph.connections.push_back(std::move(edge));
  }
  if(!next(row,"end")||!end(row))return false;source>>std::ws;if(!source.eof())return false;
  result=std::move(graph);return true;
}
