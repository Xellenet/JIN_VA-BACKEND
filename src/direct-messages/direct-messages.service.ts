import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DirectMessage } from './entities/direct-message.entity';
import { User } from '../users/entities/user.entity';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';

@Injectable()
export class DirectMessagesService {
  constructor(
    @InjectRepository(DirectMessage)
    private readonly dmRepo: Repository<DirectMessage>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async getConversations(userId: number) {
    const rows = await this.dmRepo
      .createQueryBuilder('dm')
      .select([
        'dm.id',
        'dm.content',
        'dm.isRead',
        'dm.createdAt',
        'sender.id',
        'sender.firstname',
        'sender.lastname',
        'sender.profilePicture',
        'receiver.id',
        'receiver.firstname',
        'receiver.lastname',
        'receiver.profilePicture',
      ])
      .leftJoin('dm.sender', 'sender')
      .leftJoin('dm.receiver', 'receiver')
      .where('sender.id = :uid OR receiver.id = :uid', { uid: userId })
      .orderBy('dm.createdAt', 'DESC')
      .getMany();

    // Keep only the latest message per unique contact
    const seen = new Map<number, DirectMessage>();
    for (const dm of rows) {
      const contactId = dm.sender.id === userId ? dm.receiver.id : dm.sender.id;
      if (!seen.has(contactId)) seen.set(contactId, dm);
    }

    const conversations = await Promise.all(
      Array.from(seen.entries()).map(async ([contactId, dm]) => {
        const contact = dm.sender.id === userId ? dm.receiver : dm.sender;
        const unreadCount = await this.dmRepo.count({
          where: { sender: { id: contactId }, receiver: { id: userId }, isRead: false },
        });
        return {
          contact: {
            id: contact.id,
            firstname: contact.firstname,
            lastname: contact.lastname,
            profilePicture: contact.profilePicture ?? null,
          },
          lastMessage: dm.content,
          lastMessageTime: dm.createdAt,
          lastSenderId: dm.sender.id,
          unreadCount,
        };
      }),
    );

    return conversations;
  }

  async getMessages(currentUserId: number, otherUserId: number, page = 1, limit = 30) {
    const other = await this.userRepo.findOne({ where: { id: otherUserId } });
    if (!other) throw new NotFoundException('User not found');

    const [items, total] = await this.dmRepo
      .createQueryBuilder('dm')
      .select([
        'dm.id',
        'dm.content',
        'dm.isRead',
        'dm.createdAt',
        'sender.id',
        'sender.firstname',
        'sender.lastname',
        'sender.profilePicture',
      ])
      .leftJoin('dm.sender', 'sender')
      .where(
        '(dm.sender_id = :me AND dm.receiver_id = :other) OR (dm.sender_id = :other AND dm.receiver_id = :me)',
        { me: currentUserId, other: otherUserId },
      )
      .orderBy('dm.createdAt', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit };
  }

  async sendMessage(senderId: number, receiverId: number, dto: SendDirectMessageDto) {
    const [sender, receiver] = await Promise.all([
      this.userRepo.findOne({ where: { id: senderId } }),
      this.userRepo.findOne({ where: { id: receiverId } }),
    ]);
    if (!receiver) throw new NotFoundException('Recipient not found');
    if (!sender) throw new NotFoundException('Sender not found');

    // Use ID references so create() resolves the single-entity overload correctly
    const dm = this.dmRepo.create({ sender: { id: senderId }, receiver: { id: receiverId }, content: dto.content });
    const saved = await this.dmRepo.save(dm);

    return {
      id: saved.id,
      content: saved.content,
      isRead: saved.isRead,
      createdAt: saved.createdAt,
      sender: {
        id: sender.id,
        firstname: sender.firstname,
        lastname: sender.lastname,
        profilePicture: sender.profilePicture ?? null,
      },
    };
  }

  async markRead(currentUserId: number, otherUserId: number) {
    await this.dmRepo
      .createQueryBuilder()
      .update(DirectMessage)
      .set({ isRead: true })
      .where('sender_id = :other AND receiver_id = :me AND is_read = false', {
        other: otherUserId,
        me: currentUserId,
      })
      .execute();
    return { success: true };
  }
}
