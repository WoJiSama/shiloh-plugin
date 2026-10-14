type BaseClass=new(event:unknown)=>{screenData:Record<string,unknown>;model:string}

export function createFriendsModel(Base:BaseClass){
return class FriendsModel extends Base {
    constructor (e:unknown) {
        super(e)
        this.model = 'friends'
    }

    /** 生成版本信息图片 */
    async getData (friendsData:unknown, myNickName:unknown) {
        return {
            ...this.screenData,
            saveId: 'friends',
            friendsData: friendsData,
            myNickName: myNickName
        }
    }
}

}
